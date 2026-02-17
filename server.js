require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── 前端靜態檔案 ──
app.use(express.static(path.join(__dirname, 'public')));

// ── 資料存在記憶體（免費方案不重啟就不會消失）──
let schedules = [];

// ── Gmail 寄信設定 ──
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });
}

// ── 驗證 API 金鑰 ──
app.post('/api/test-key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, message: '未提供 API 金鑰' });
  try {
    await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: 'test', maxResults: 1, key: apiKey },
    });
    res.json({ valid: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || '金鑰無效';
    res.status(400).json({ valid: false, message: msg });
  }
});

// ── 取得所有排程 ──
app.get('/api/schedules', (req, res) => {
  res.json(schedules);
});

// ── 建立排程 ──
app.post('/api/schedules', (req, res) => {
  const { name, apiKey, channels, weeks, frequency, sendTime, emails } = req.body;
  if (!name || !apiKey || !channels?.length || !emails?.length) {
    return res.status(400).json({ message: '請填寫所有必填欄位' });
  }
  const schedule = {
    id: uuidv4(),
    name, apiKey, channels, weeks: weeks || 4,
    frequency, sendTime: sendTime || '09:00',
    emails,
    active: true,
    createdAt: new Date().toISOString(),
  };
  schedules.push(schedule);
  registerCron(schedule);
  res.json(schedule);
});

// ── 更新頻道清單 ──
app.patch('/api/schedules/:id/channels', (req, res) => {
  const s = schedules.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ message: '找不到排程' });
  s.channels = req.body.channels;
  res.json(s);
});

// ── 啟用/暫停 ──
app.post('/api/schedules/:id/toggle', (req, res) => {
  const s = schedules.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ message: '找不到排程' });
  s.active = req.body.active;
  res.json(s);
});

// ── 立即執行 ──
app.post('/api/schedules/:id/run', async (req, res) => {
  const s = schedules.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ message: '找不到排程' });
  res.json({ message: '分析已開始，完成後將寄送報告到信箱' });
  runAnalysis(s).catch(console.error);
});

// ── 刪除排程 ──
app.delete('/api/schedules/:id', (req, res) => {
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: '找不到排程' });
  const [removed] = schedules.splice(idx, 1);
  if (removed._cronJob) removed._cronJob.stop();
  res.json({ message: '已刪除' });
});

// ── 前端 catch-all ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════
//  核心：YouTube 搜尋 + 寄信
// ══════════════════════════════════
async function runAnalysis(schedule) {
  console.log(`[${new Date().toISOString()}] 開始分析排程：${schedule.name}`);
  const results = [];
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - (schedule.weeks || 4) * 7);

  for (const channel of schedule.channels) {
    try {
      // 1. 搜尋頻道
      const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet', q: channel, type: 'channel',
          maxResults: 1, key: schedule.apiKey,
        },
      });
      const channelId = searchRes.data.items?.[0]?.id?.channelId;
      if (!channelId) { console.log(`找不到頻道：${channel}`); continue; }

      // 2. 撈影片清單
      const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet', channelId, type: 'video',
          publishedAfter: sinceDate.toISOString(),
          maxResults: 50, order: 'date', key: schedule.apiKey,
        },
      });

      for (const item of videosRes.data.items || []) {
        const title = item.snippet.title;
        const desc = item.snippet.description || '';
        const videoId = item.id.videoId;
        const publishedAt = item.snippet.publishedAt;

        // 3. 判斷是否業配（常見業配關鍵字）
        const sponsorKeywords = [
          '業配', '贊助', '合作', 'sponsored', 'ad ', '#ad',
          'partnership', '合作夥伴', 'promotion', '推廣',
        ];
        const combined = (title + ' ' + desc).toLowerCase();
        const isSponsor = sponsorKeywords.some(k => combined.includes(k.toLowerCase()));

        if (isSponsor) {
          // 4. 抓影片描述中的連結
          const urlRegex = /https?:\/\/[^\s)>\]]+/g;
          const links = desc.match(urlRegex) || [];
          results.push({
            頻道: channel,
            影片標題: title,
            發布日期: new Date(publishedAt).toLocaleDateString('zh-TW'),
            業配連結: links.slice(0, 3).join(' | ') || '（無連結）',
            影片網址: `https://www.youtube.com/watch?v=${videoId}`,
          });
        }
      }
    } catch (err) {
      console.error(`分析頻道「${channel}」失敗：`, err.message);
    }
  }

  // 5. 產生 CSV
  const csvHeader = '頻道,影片標題,發布日期,業配連結,影片網址\n';
  const csvRows = results.map(r =>
    `"${r.頻道}","${r.影片標題.replace(/"/g, '""')}","${r.發布日期}","${r.業配連結}","${r.影片網址}"`
  ).join('\n');
  const csv = '\uFEFF' + csvHeader + csvRows; // BOM for Excel 中文相容

  // 6. 寄信
  await sendReport(schedule, csv, results.length);
  console.log(`[${new Date().toISOString()}] 排程「${schedule.name}」完成，共 ${results.length} 筆業配`);
}

async function sendReport(schedule, csv, count) {
  const transporter = createTransporter();
  const dateStr = new Date().toLocaleDateString('zh-TW');
  await transporter.sendMail({
    from: `YouTube 業配系統 <${process.env.GMAIL_USER}>`,
    to: schedule.emails.join(', '),
    subject: `📊 ${schedule.name} 業配報告 — ${dateStr}（共 ${count} 筆）`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#e63030;">📊 YouTube 業配分析報告</h2>
        <p><b>排程名稱：</b>${schedule.name}</p>
        <p><b>分析期間：</b>近 ${schedule.weeks} 週</p>
        <p><b>監控頻道：</b>${schedule.channels.join('、')}</p>
        <p><b>找到業配：</b>${count} 筆</p>
        <p><b>產生時間：</b>${new Date().toLocaleString('zh-TW')}</p>
        <hr style="margin:20px 0;">
        <p style="color:#888;font-size:0.85em;">詳細資料請見附件 CSV 檔，可用 Excel 開啟</p>
      </div>
    `,
    attachments: [{
      filename: `業配報告_${schedule.name}_${dateStr}.csv`,
      content: csv,
      encoding: 'utf8',
    }],
  });
}

// ══════════════════════════════════
//  排程管理
// ══════════════════════════════════
const cronJobs = {};

function getCronExpression(frequency, sendTime) {
  const [hour, minute] = (sendTime || '09:00').split(':');
  if (frequency === 'daily')   return `${minute} ${hour} * * *`;
  if (frequency === 'weekly')  return `${minute} ${hour} * * 1`; // 每週一
  if (frequency === 'monthly') return `${minute} ${hour} 1 * *`; // 每月1日
  return `${minute} ${hour} * * 1`;
}

function registerCron(schedule) {
  if (cronJobs[schedule.id]) cronJobs[schedule.id].stop();
  const expr = getCronExpression(schedule.frequency, schedule.sendTime);
  cronJobs[schedule.id] = cron.schedule(expr, () => {
    if (schedule.active) runAnalysis(schedule).catch(console.error);
  }, { timezone: 'Asia/Taipei' });
}

// ══════════════════════════════════
//  啟動伺服器
// ══════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 伺服器啟動於 port ${PORT}`);
});
