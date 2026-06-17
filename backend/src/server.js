import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import reservationRoutes from './routes/reservations.js';
import userRoutes from './routes/users.js';
import dailySettingsRoutes from './routes/dailySettings.js';
import { startCronJobs } from './cronJobs.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Start background cron jobs
startCronJobs();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies to be sent
}));
app.use(express.json());
app.use(cookieParser());

// Routes
app.get('/', (req, res) => {
  res.send('預約系統後端伺服器運行中！請前往前端網址 (通常為 http://localhost:5173) 操作系統。');
});
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/daily-settings', dailySettingsRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
