const fs = require('fs');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const { google } = require('googleapis');

// credentials.json を復元
const credentialsB64 = process.env.GOOGLE_CREDENTIALS_B64;
if (credentialsB64) {
  const credentialsJson = Buffer.from(credentialsB64, 'base64').toString('utf-8');
  fs.writeFileSync('./credentials.json', credentialsJson);
}
const credentials = require('./credentials.json');

// 各種設定
const SPREADSHEET_ID = '1HixtxBa4Zph88RZSY0ffh8XXB0sVlSCuDI8MWnq_6f8';
const MASTER_SHEET = 'list';
const LOG_SHEET = 'ログ';
const TARGET_CHANNEL_ID = '1365277821743927296'; // 書き込むチャンネルID
const pendingUsers = new Map();

// Google Sheets 認証
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Discord Bot 設定
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ボタン送信関数
async function postButtons(channel) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${MASTER_SHEET}!A2:A`,
    });
    const items = res.data.values?.flat().filter(Boolean);
    if (!items || items.length === 0) return;

    const rows = [];
    for (let i = 0; i < items.length; i += 5) {
      const rowButtons = items.slice(i, i + 5).map(item =>
        new ButtonBuilder()
          .setCustomId(`item_${item}`)
          .setLabel(item)
          .setStyle(ButtonStyle.Primary)
      );
      rows.push(new ActionRowBuilder().addComponents(rowButtons));
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    for (const msg of messages.values()) {
      if (msg.author.id === client.user.id) await msg.delete();
    }

    await channel.send({
      content: '記録する項目を選ぶのじゃ',
      components: rows,
    });
  } catch (err) {
    console.error('❌ ボタン送信失敗:', err);
  }
}

// Bot起動時
client.once(Events.ClientReady, async () => {
  console.log(`🚀 Bot is ready!`);
  const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
  if (!channel) return console.error("❌ チャンネルが見つかりません");

  await postButtons(channel);
  setInterval(() => postButtons(channel), 5 * 60 * 1000); // 5分ごとに再送信
});

// ボタンが押されたとき
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.channelId !== TARGET_CHANNEL_ID) return; // チャンネルチェック！

  const item = interaction.customId.replace('item_', '');
  const displayName = interaction.member?.nickname || interaction.user.username;
  pendingUsers.set(interaction.user.id, { item, name: displayName });

  await interaction.reply({
    content: `**${item}** を選んだのじゃ。\n次に「数量 メモ（任意）」を入力するのじゃ。\n例：\`3 重要アイテム\``,
    ephemeral: true,
  });
});

// メッセージを受信したとき
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== TARGET_CHANNEL_ID) return; // チャンネルチェック！

  const pending = pendingUsers.get(message.author.id);
  const [amountStr, ...memoParts] = message.content.trim().split(/\s+/);
  const quantity = parseInt(amountStr);
  const memo = memoParts.join(' ');
  const name = message.member?.nickname || message.author.username;
  const date = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const logs = [];

  if (pending) {
    const selected = pending.item;
    pendingUsers.delete(message.author.id);

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${MASTER_SHEET}!A2:J`,
      });

      const rows = res.data.values || [];
      const row = rows.find(r => r[0] === selected);
      if (!row) return message.reply('❌ 該当アイテムが見つかりません');

      const createPer = parseInt(row[1]) || 1;
      const totalAmount = quantity * createPer;
      const autoMemo = `[${selected}作成用]`;

      logs.push([date, name, selected, totalAmount, memo, autoMemo]);

      for (let i = 0; i < 4; i++) {
        const mat = row[2 + i * 2];
        const matQty = parseInt(row[3 + i * 2]);
        if (mat && matQty) {
          logs.push([date, name, mat, -matQty * quantity, '', autoMemo]);
        }
      }

    } catch (err) {
      console.error("❌ データ取得失敗:", err);
      return;
    }

  } else {
    const item = amountStr;
    const amount = parseInt(memoParts[0]) || 0;
    const rawMemo = memoParts.slice(1).join(' ');
    logs.push([date, name, item, amount, rawMemo, '']);
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOG_SHEET}!A:F`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: logs,
      },
    });

    await message.react('🏯');
  } catch (err) {
    console.error("❌ 書き込み失敗:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);
