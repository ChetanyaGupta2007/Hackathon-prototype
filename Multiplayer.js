const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// In-memory rooms state
// roomId -> { players: { socketId: { username, score, streak } }, questions: [...], index, started }
const rooms = {};

// helper: build points like client uses
function computePoints(mode, isCorrect, timeTaken, streak) {
  if (!isCorrect) return 0;
  if (mode === 'multiple-correct') {
    let pts = 20 + (timeTaken <= 8 ? 15 : 0) + (streak > 1 ? streak * 7 : 0);
    return pts;
  } else { // standard / fact-fiction
    let pts = 10 + (timeTaken <= 5 ? 10 : 0) + (streak > 1 ? streak * 5 : 0);
    return pts;
  }
}

// fetch questions from OpenTDB (or fallback)
async function fetchQuestions(amount=10, category=null, type='multiple') {
  try {
    const catParam = category ? `&category=${category}` : '';
    const res = await axios.get(`https://opentdb.com/api.php?amount=${amount}${catParam}&type=${type}`);
    if (res.data && res.data.results) {
      return res.data.results.map((q, i) => ({
        question: q.question,
        options: [...(q.incorrect_answers || []), q.correct_answer].sort(() => Math.random()-0.5),
        answer: q.correct_answer,
        explanation: '' // server doesn't need explanation for gameplay
      }));
    }
  } catch(err) {
    console.warn('OpenTDB failed, using fallback');
  }
  // fallback minimal set
  return [
    { question: "What is the chemical symbol for water?", options: ["O2","H2O","CO2","NaCl"], answer: "H2O"},
    { question: "What planet is known as the 'Red Planet'?", options: ["Jupiter","Venus","Mars","Saturn"], answer: "Mars"},
    { question: "Which force keeps planets in orbit around the Sun?", options: ["Electromagnetism","Tension","Gravity","Friction"], answer: "Gravity"}
  ];
}

io.on('connection', (socket) => {
  console.log('conn', socket.id);

  // join/create room
  socket.on('joinRoom', async ({ roomId, username, mode, category }) => {
    if (!roomId) return socket.emit('errorMsg', 'No room id provided');
    socket.join(roomId);
    rooms[roomId] = rooms[roomId] || { players: {}, questions: null, index: 0, started: false, mode: mode || 'standard', category };

    rooms[roomId].players[socket.id] = { username: username || 'Guest', score: 0, streak: 0, correct:0, wrong:0 };
    console.log(`${username} joined ${roomId}`);

    io.to(roomId).emit('lobbyUpdate', {
      players: Object.values(rooms[roomId].players).map(p => ({ username: p.username, score: p.score }))
    });

    // if questions not prepared, prepare them now
    if (!rooms[roomId].questions) {
      const qset = await fetchQuestions(10, category || null, 'multiple');
      rooms[roomId].questions = qset;
    }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    if (!rooms[roomId]) return;
    delete rooms[roomId].players[socket.id];
    socket.leave(roomId);
    io.to(roomId).emit('lobbyUpdate', { players: Object.values(rooms[roomId].players).map(p => ({ username: p.username, score: p.score })) });
  });

  // host triggers start (anyone can request start)
  socket.on('startRoom', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', 'Room not found');
    if (room.started) return;
    room.started = true;
    room.index = 0;
    // broadcast first question
    io.to(roomId).emit('gameStarted', { totalQuestions: room.questions.length });
    sendQuestionToRoom(roomId);
  });

  // client answers
  socket.on('playerAnswer', ({ roomId, answer, timeTaken }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const q = room.questions[room.index];
    const isCorrect = q.answer === answer;
    if (isCorrect) {
      player.streak = (player.streak || 0) + 1;
      player.correct = (player.correct || 0) + 1;
    } else {
      player.streak = 0;
      player.wrong = (player.wrong || 0) + 1;
    }
    const pts = computePoints(room.mode, isCorrect, timeTaken || 0, player.streak);
    player.score += pts;

    // inform the player about result (private)
    socket.emit('answerResult', { isCorrect, earned: pts, correctAnswer: q.answer });

    // update room scoreboard to all
    io.to(roomId).emit('scoreUpdate', {
      players: Object.values(room.players).map(p => ({ username: p.username, score: p.score, correct: p.correct || 0, wrong: p.wrong || 0 }))
    });
  });

  // next question trigger (server advances to next question after a sync period)
  socket.on('requestNext', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    // move to next
    room.index++;
    if (room.index >= room.questions.length) {
      // game over -> build leaderboard
      const leaderboard = Object.values(room.players)
        .map(p => ({ username: p.username, score: p.score }))
        .sort((a,b) => b.score - a.score);
      io.to(roomId).emit('gameOver', { leaderboard });
      // optionally clear room
      //delete rooms[roomId];
    } else {
      sendQuestionToRoom(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconn', socket.id);
    // remove from any room
    for (const rId of Object.keys(rooms)) {
      if (rooms[rId].players && rooms[rId].players[socket.id]) {
        delete rooms[rId].players[socket.id];
        io.to(rId).emit('lobbyUpdate', { players: Object.values(rooms[rId].players).map(p => ({ username: p.username, score: p.score })) });
      }
    }
  });
});

// helper to send question + countdown
function sendQuestionToRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const q = room.questions[room.index];
  // server decides a question duration (in seconds)
  const duration = 12;
  // include index so clients can track
  io.to(roomId).emit('question', {
    index: room.index,
    total: room.questions.length,
    question: q.question,
    options: q.options,
    duration
  });
  // after duration, automatically move to next question
  setTimeout(() => {
    // when timer finishes, advance index and send next if not last
    room.index++;
    if (room.index >= room.questions.length) {
      const leaderboard = Object.values(room.players)
        .map(p => ({ username: p.username, score: p.score }))
        .sort((a,b) => b.score - a.score);
      io.to(roomId).emit('gameOver', { leaderboard });
    } else {
      sendQuestionToRoom(roomId);
    }
  }, duration * 1000 + 500); // small buffer
}

app.get('/', (req, res) => {
  res.send({ ok: true, msg: 'Quiz multiplayer server running' });
});

server.listen(PORT, () => console.log('Server listening on', PORT));
