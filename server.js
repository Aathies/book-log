const express = require('express');
const cors = require('cors');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(cors());
app.use(express.json());

// Handle production flag
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const PORT = isProduction ? 3000 : 5000;

// Initialize SQLite database
const db = new DatabaseSync(path.join(__dirname, 'books.db'));
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    total_pages INTEGER NOT NULL,
    genre TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reading_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    pages_read INTEGER NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
  );
`);

// Date helper to get YYYY-MM-DD in local timezone
function getLocalDateString(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split('T')[0];
}

// Streak calculation helper
function calculateStreaks(dates) {
  // dates should be an array of unique YYYY-MM-DD strings sorted descending
  if (dates.length === 0) return { current: 0, longest: 0 };

  const todayStr = getLocalDateString(new Date());
  const yesterdayStr = getLocalDateString(new Date(Date.now() - 86400000));

  let current = 0;
  // If the latest log is today or yesterday, the streak is active
  if (dates[0] === todayStr || dates[0] === yesterdayStr) {
    current = 1;
    let prevDate = new Date(dates[0]);
    
    for (let i = 1; i < dates.length; i++) {
      const currDate = new Date(dates[i]);
      const diffTime = prevDate - currDate;
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) {
        current++;
        prevDate = currDate;
      } else if (diffDays > 1) {
        break;
      }
    }
  }

  // Calculate longest streak
  let longest = 0;
  if (dates.length > 0) {
    const ascDates = [...dates].reverse();
    let tempStreak = 1;
    longest = 1;
    let prevDate = new Date(ascDates[0]);

    for (let i = 1; i < ascDates.length; i++) {
      const currDate = new Date(ascDates[i]);
      const diffTime = currDate - prevDate;
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        tempStreak++;
        if (tempStreak > longest) {
          longest = tempStreak;
        }
      } else if (diffDays > 1) {
        tempStreak = 1;
      }
      prevDate = currDate;
    }
  }

  return { current, longest };
}

// Helper to format a single book with calculated stats
function formatBook(book, logs) {
  const bookLogs = logs.filter(log => log.book_id === book.id);
  const totalPagesRead = bookLogs.reduce((sum, log) => sum + log.pages_read, 0);
  const cappedPagesRead = Math.min(book.total_pages, totalPagesRead);
  const progressPercent = Math.min(100, Math.round((cappedPagesRead / book.total_pages) * 100));
  const isCompleted = cappedPagesRead >= book.total_pages;

  const uniqueDates = [...new Set(bookLogs.map(log => log.date))].sort((a, b) => b.localeCompare(a));
  const activeDays = uniqueDates.length;

  let averagePace = 0;
  let daysRemaining = null;
  let estimatedCompletionDate = null;

  if (isCompleted) {
    const lastLogDate = bookLogs.length > 0 ? bookLogs[bookLogs.length - 1].date : null;
    estimatedCompletionDate = lastLogDate ? `Completed on ${lastLogDate}` : 'Completed';
  } else if (cappedPagesRead > 0 && activeDays > 0) {
    averagePace = parseFloat((cappedPagesRead / activeDays).toFixed(1));
    const remainingPages = book.total_pages - cappedPagesRead;
    daysRemaining = Math.ceil(remainingPages / averagePace);

    const today = new Date();
    const compDate = new Date(today.getTime() + daysRemaining * 24 * 60 * 60 * 1000);
    estimatedCompletionDate = getLocalDateString(compDate);
  }

  const { current: currentStreak, longest: longestStreak } = calculateStreaks(uniqueDates);

  return {
    ...book,
    pages_read: cappedPagesRead,
    progress_percentage: progressPercent,
    is_completed: isCompleted,
    active_days: activeDays,
    average_pace: averagePace,
    days_remaining: daysRemaining,
    estimated_completion_date: estimatedCompletionDate,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    logs: bookLogs
  };
}

// API Routes

// 1. Get all books with aggregated data
app.get('/api/books', (req, res) => {
  try {
    const books = db.prepare('SELECT * FROM books ORDER BY id DESC').all();
    const logs = db.prepare('SELECT * FROM reading_logs ORDER BY date ASC').all();
    
    const formattedBooks = books.map(book => formatBook(book, logs));
    res.json(formattedBooks);
  } catch (error) {
    console.error('Error fetching books:', error);
    res.status(500).json({ error: 'Failed to retrieve books' });
  }
});

// 2. Get a single book's details
app.get('/api/books/:id', (req, res) => {
  try {
    const bookId = parseInt(req.params.id);
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const logs = db.prepare('SELECT * FROM reading_logs WHERE book_id = ? ORDER BY date ASC').all(bookId);
    res.json(formatBook(book, logs));
  } catch (error) {
    console.error('Error fetching book:', error);
    res.status(500).json({ error: 'Failed to retrieve book' });
  }
});

// 3. Add a new book
app.post('/api/books', (req, res) => {
  try {
    const { title, author, total_pages, genre } = req.body;

    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required and must be a valid string' });
    }
    if (!author || typeof author !== 'string' || author.trim() === '') {
      return res.status(400).json({ error: 'Author is required and must be a valid string' });
    }
    const totalPages = parseInt(total_pages);
    if (isNaN(totalPages) || totalPages <= 0) {
      return res.status(400).json({ error: 'Total pages must be a positive integer greater than 0' });
    }
    if (!genre || typeof genre !== 'string' || genre.trim() === '') {
      return res.status(400).json({ error: 'Genre is required and must be a valid string' });
    }

    const insert = db.prepare('INSERT INTO books (title, author, total_pages, genre) VALUES (?, ?, ?, ?)');
    const result = insert.run(title.trim(), author.trim(), totalPages, genre.trim());

    const newBook = db.prepare('SELECT * FROM books WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(formatBook(newBook, []));
  } catch (error) {
    console.error('Error adding book:', error);
    res.status(500).json({ error: 'Failed to add book' });
  }
});

// 4. Log progress for a book
app.post('/api/books/:id/log', (req, res) => {
  try {
    const bookId = parseInt(req.params.id);
    const { pages_read, date } = req.body;

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const pagesRead = parseInt(pages_read);
    if (isNaN(pagesRead) || pagesRead <= 0) {
      return res.status(400).json({ error: 'Pages read must be a positive integer greater than 0' });
    }

    // Set date or fallback to today
    let dateStr = date;
    if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      dateStr = getLocalDateString(new Date());
    }

    // Calculate current progress
    const logs = db.prepare('SELECT * FROM reading_logs WHERE book_id = ?').all(bookId);
    const totalReadSoFar = logs.reduce((sum, log) => sum + log.pages_read, 0);
    const remainingPages = book.total_pages - totalReadSoFar;

    if (pagesRead > remainingPages) {
      return res.status(400).json({ 
        error: `Cannot log ${pagesRead} pages. Only ${remainingPages} pages remaining in "${book.title}".` 
      });
    }

    const insertLog = db.prepare('INSERT INTO reading_logs (book_id, pages_read, date) VALUES (?, ?, ?)');
    insertLog.run(bookId, pagesRead, dateStr);

    // Retrieve updated logs and format
    const updatedLogs = db.prepare('SELECT * FROM reading_logs WHERE book_id = ? ORDER BY date ASC').all(bookId);
    res.status(201).json(formatBook(book, updatedLogs));
  } catch (error) {
    console.error('Error logging reading progress:', error);
    res.status(500).json({ error: 'Failed to log reading progress' });
  }
});

// 5. Delete a book
app.delete('/api/books/:id', (req, res) => {
  try {
    const bookId = parseInt(req.params.id);
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
    
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
    res.json({ success: true, message: `Successfully deleted book "${book.title}"` });
  } catch (error) {
    console.error('Error deleting book:', error);
    res.status(500).json({ error: 'Failed to delete book' });
  }
});

// 6. Get global stats
app.get('/api/stats', (req, res) => {
  try {
    const books = db.prepare('SELECT * FROM books').all();
    const logs = db.prepare('SELECT * FROM reading_logs ORDER BY date DESC').all();

    const totalBooks = books.length;
    const formattedBooks = books.map(book => formatBook(book, logs));
    const completedBooks = formattedBooks.filter(b => b.is_completed).length;
    const totalPagesRead = logs.reduce((sum, log) => sum + log.pages_read, 0);

    // Global streak
    const uniqueDates = [...new Set(logs.map(log => log.date))].sort((a, b) => b.localeCompare(a));
    const streaks = calculateStreaks(uniqueDates);

    res.json({
      total_books: totalBooks,
      completed_books: completedBooks,
      active_books: totalBooks - completedBooks,
      total_pages_read: totalPagesRead,
      current_streak: streaks.current,
      longest_streak: streaks.longest
    });
  } catch (error) {
    console.error('Error fetching global stats:', error);
    res.status(500).json({ error: 'Failed to retrieve global statistics' });
  }
});

// Serve static frontend in production
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// For SPA routing, serve index.html for unmatched routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send('Book Reading Tracker API is running. Build the frontend to see the dashboard.');
    }
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT} (${isProduction ? 'Production' : 'Development'} mode)`);
});
