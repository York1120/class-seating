/**
 * 班级排座位系统 - 后端服务器
 * 基于 Node.js + Express + SQLite
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 确保数据目录 ==========
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== 数据库初始化 ==========
const db = new Database(path.join(DATA_DIR, 'seating.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rows INTEGER NOT NULL DEFAULT 6,
    cols INTEGER NOT NULL DEFAULT 6,
    podium TEXT NOT NULL DEFAULT 'top',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    student_name TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(row_index, col_index)
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// 初始化默认配置（如果不存在）
const existingConfig = db.prepare('SELECT id FROM config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO config (id, rows, cols, podium) VALUES (1, 6, 6, \'top\')').run();
  
  // 初始化空座位
  const insertSeat = db.prepare('INSERT OR IGNORE INTO seats (row_index, col_index) VALUES (?, ?)');
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      insertSeat.run(r, c);
    }
  }
}

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== 静态文件服务 ==========
app.use(express.static(path.join(__dirname, 'public')));

// 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ========== API 路由 ==========

/**
 * 获取完整配置（行列数 + 座位安排 + 学生名单）
 */
app.get('/api/config', (req, res) => {
  try {
    const config = db.prepare('SELECT rows, cols, podium FROM config WHERE id = 1').get();
    const seats = db.prepare('SELECT row_index, col_index, student_name FROM seats ORDER BY row_index, col_index').all();
    const students = db.prepare('SELECT name FROM students ORDER BY name').all();

    // 构建 grid 二维数组
    const grid = Array.from({ length: config.rows }, () => Array(config.cols).fill(null));
    seats.forEach(seat => {
      if (seat.row_index < config.rows && seat.col_index < config.cols) {
        grid[seat.row_index][seat.col_index] = seat.student_name || null;
      }
    });

    res.json({
      success: true,
      data: {
        rows: config.rows,
        cols: config.cols,
        podium: config.podium,
        grid,
        students: students.map(s => s.name)
      }
    });
  } catch (err) {
    console.error('获取配置失败:', err);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

/**
 * 保存完整配置
 */
app.post('/api/config', (req, res) => {
  try {
    const { rows, cols, podium, grid, students } = req.body;

    // 验证参数
    if (!rows || !cols || rows < 1 || rows > 30 || cols < 1 || cols > 30) {
      return res.status(400).json({ success: false, message: '行列数需在 1-30 之间' });
    }
    const validPodiums = ['top', 'bottom', 'left', 'right'];
    if (podium && !validPodiums.includes(podium)) {
      return res.status(400).json({ success: false, message: '讲台位置无效' });
    }

    const finalRows = rows;
    const finalCols = cols;
    const finalPodium = podium || 'top';

    // 开启事务
    const transaction = db.transaction(() => {
      // 更新 config
      db.prepare('UPDATE config SET rows = ?, cols = ?, podium = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = 1')
        .run(finalRows, finalCols, finalPodium);

      // 重建座位表（删除旧座位，插入新座位）
      db.prepare('DELETE FROM seats').run();
      const insertSeat = db.prepare('INSERT INTO seats (row_index, col_index, student_name) VALUES (?, ?, ?)');
      
      for (let r = 0; r < finalRows; r++) {
        for (let c = 0; c < finalCols; c++) {
          const name = (grid && grid[r] && grid[r][c]) ? String(grid[r][c]).trim() : null;
          insertSeat.run(r, c, name || null);
        }
      }

      // 重建学生名单
      db.prepare('DELETE FROM students').run();
      if (students && Array.isArray(students)) {
        const insertStudent = db.prepare('INSERT INTO students (name) VALUES (?)');
        students.forEach(name => {
          if (name && name.trim()) {
            try { insertStudent.run(name.trim()); } catch(e) { /* 忽略重复 */ }
          }
        });
      }
    });

    transaction();
    res.json({ success: true, message: '保存成功' });
  } catch (err) {
    console.error('保存配置失败:', err);
    res.status(500).json({ success: false, message: '保存失败: ' + err.message });
  }
});

/**
 * 随机排座
 */
app.post('/api/random-assign', (req, res) => {
  try {
    const config = db.prepare('SELECT rows, cols FROM config WHERE id = 1').get();
    const unseated = db.prepare("SELECT name FROM students WHERE name NOT IN (SELECT student_name FROM seats WHERE student_name IS NOT NULL)").all();
    
    if (unseated.length === 0) {
      return res.json({ success: true, message: '没有未安排的学生', assigned: 0 });
    }

    // 获取空座位
    const emptySeats = db.prepare('SELECT row_index, col_index FROM seats WHERE student_name IS NULL ORDER BY row_index, col_index').all();
    
    if (emptySeats.length === 0) {
      return res.json({ success: true, message: '没有空位', assigned: 0 });
    }

    // 打乱学生顺序和空位顺序
    const shuffledStudents = [...unseated.map(s => s.name)];
    const shuffledSeats = [...emptySeats];
    
    for (let i = shuffledStudents.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledStudents[i], shuffledStudents[j]] = [shuffledStudents[j], shuffledStudents[i]];
    }
    for (let i = shuffledSeats.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledSeats[i], shuffledSeats[j]] = [shuffledSeats[j], shuffledSeats[i]];
    }

    const count = Math.min(shuffledStudents.length, shuffledSeats.length);
    const updateSeat = db.prepare('UPDATE seats SET student_name = ?, updated_at = datetime(\'now\', \'localtime\') WHERE row_index = ? AND col_index = ?');
    
    const transaction = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        updateSeat.run(shuffledStudents[i], shuffledSeats[i].row_index, shuffledSeats[i].col_index);
      }
    });
    transaction();

    res.json({ success: true, message: `已随机安排 ${count} 位同学`, assigned: count });
  } catch (err) {
    console.error('随机排座失败:', err);
    res.status(500).json({ success: false, message: '随机排座失败' });
  }
});

/**
 * 导入 Excel 学生名单
 */
app.post('/api/import/excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请上传文件' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

    const names = [];
    for (const row of data) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell && String(cell).trim()) {
          const name = String(cell).trim();
          if (!names.includes(name)) names.push(name);
        }
      }
    }

    if (names.length === 0) {
      return res.json({ success: false, message: '未找到学生姓名' });
    }

    let imported = 0;
    const insertStudent = db.prepare('INSERT OR IGNORE INTO students (name) VALUES (?)');
    const transaction = db.transaction(() => {
      names.forEach(name => {
        const result = insertStudent.run(name);
        if (result.changes > 0) imported++;
      });
    });
    transaction();

    res.json({
      success: true,
      message: `成功导入 ${imported} 位学生（共识别 ${names.length} 人，${names.length - imported} 人已存在）`,
      imported,
      total: names.length
    });
  } catch (err) {
    console.error('导入失败:', err);
    res.status(500).json({ success: false, message: '导入失败: ' + err.message });
  }
});

/**
 * 按姓名/格式导入学生（支持 JSON/纯文本）
 */
app.post('/api/import/students', (req, res) => {
  try {
    const { names } = req.body;
    if (!names || !Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ success: false, message: '请提供学生姓名列表' });
    }

    let imported = 0;
    const insertStudent = db.prepare('INSERT OR IGNORE INTO students (name) VALUES (?)');
    const transaction = db.transaction(() => {
      names.forEach(name => {
        if (name && name.trim()) {
          const result = insertStudent.run(name.trim());
          if (result.changes > 0) imported++;
        }
      });
    });
    transaction();

    res.json({ success: true, message: `成功导入 ${imported} 位学生`, imported });
  } catch (err) {
    console.error('导入失败:', err);
    res.status(500).json({ success: false, message: '导入失败: ' + err.message });
  }
});

/**
 * 添加单个学生
 */
app.post('/api/students', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '姓名不能为空' });
    }
    db.prepare('INSERT OR IGNORE INTO students (name) VALUES (?)').run(name.trim());
    res.json({ success: true, message: `已添加「${name.trim()}」` });
  } catch (err) {
    res.status(500).json({ success: false, message: '添加失败' });
  }
});

/**
 * 删除单个学生
 */
app.delete('/api/students/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    db.prepare('DELETE FROM students WHERE name = ?').run(name);
    // 同时清除该学生在座位上的记录
    db.prepare('UPDATE seats SET student_name = NULL WHERE student_name = ?').run(name);
    res.json({ success: true, message: `已移除「${name}」` });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

/**
 * 清空所有数据
 */
app.post('/api/clear-all', (req, res) => {
  try {
    const config = db.prepare('SELECT rows, cols FROM config WHERE id = 1').get();
    db.prepare('DELETE FROM students').run();
    db.prepare('UPDATE seats SET student_name = NULL').run();
    res.json({ success: true, message: '已清空所有数据' });
  } catch (err) {
    res.status(500).json({ success: false, message: '清空失败' });
  }
});

/**
 * 导出数据（JSON格式）
 */
app.get('/api/export', (req, res) => {
  try {
    const config = db.prepare('SELECT rows, cols, podium FROM config WHERE id = 1').get();
    const seats = db.prepare('SELECT row_index, col_index, student_name FROM seats WHERE student_name IS NOT NULL ORDER BY row_index, col_index').all();
    const students = db.prepare('SELECT name FROM students ORDER BY name').all();

    const exportData = {
      exportTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      rows: config.rows,
      cols: config.cols,
      podium: config.podium,
      seating: seats.map(s => ({
        row: s.row_index + 1,
        col: s.col_index + 1,
        name: s.student_name
      })),
      unseated: students.map(s => s.name)
    };

    res.json({ success: true, data: exportData });
  } catch (err) {
    res.status(500).json({ success: false, message: '导出失败' });
  }
});

// ========== SPA 降级处理 ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`======================================`);
  console.log(`  🏫 班级排座位系统 已启动`);
  console.log(`  🌐 本地访问: http://localhost:${PORT}`);
  console.log(`  📡 局域网访问: http://<本机IP>:${PORT}`);
  console.log(`  💾 数据存储: SQLite (data/seating.db)`);
  console.log(`======================================`);
});
