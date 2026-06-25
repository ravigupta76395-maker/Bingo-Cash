// ============================================================
//  BINGO CASH — index.js
//  Stack : Node.js · Express · MongoDB · node-telegram-bot-api
//  Deploy: Vercel (serverless)
// ============================================================

const express       = require("express");
const mongoose      = require("mongoose");
const TelegramBot   = require("node-telegram-bot-api");
const cors          = require("cors");
const path          = require("path");
const crypto        = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  ENV — Replace these in Vercel Environment Variables
// ─────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN   || "YOUR_BOT_TOKEN_HERE";
const MONGO_URI   = process.env.MONGO_URI   || "YOUR_MONGODB_URI_HERE";
const ADMIN_IDS   = (process.env.ADMIN_IDS  || "").split(",").map(s => s.trim()).filter(Boolean);
const BASE_URL    = process.env.BASE_URL    || "https://your-vercel-url.vercel.app";
const WEBAPP_URL  = process.env.WEBAPP_URL  || `${BASE_URL}/app`;

// ─────────────────────────────────────────────
//  MongoDB Models
// ─────────────────────────────────────────────
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// Settings Schema
const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});
const Settings = mongoose.model("Settings", settingsSchema);

// User Schema
const userSchema = new mongoose.Schema({
  telegramId:   { type: String, unique: true },
  username:     String,
  firstName:    String,
  balance:      { type: Number, default: 0 },
  referredBy:   String,
  referralCount:{ type: Number, default: 0 },
  upiId:        String,
  isBanned:     { type: Boolean, default: false },
  joinedAt:     { type: Date, default: Date.now },
  deviceHash:   String,
});
const User = mongoose.model("User", userSchema);

// Gift Code Schema
const giftSchema = new mongoose.Schema({
  code:       { type: String, unique: true },
  amount:     Number,
  maxUses:    { type: Number, default: 1 },
  usedCount:  { type: Number, default: 0 },
  usedBy:     [String],
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
});
const GiftCode = mongoose.model("GiftCode", giftSchema);

// Withdrawal Schema
const withdrawSchema = new mongoose.Schema({
  telegramId: String,
  amount:     Number,
  upiId:      String,
  status:     { type: String, default: "pending" }, // pending | approved | rejected
  createdAt:  { type: Date, default: Date.now },
});
const Withdrawal = mongoose.model("Withdrawal", withdrawSchema);

// ─────────────────────────────────────────────
//  Default Settings helper
// ─────────────────────────────────────────────
async function getSetting(key, defaultVal) {
  const doc = await Settings.findOne({ key });
  return doc ? doc.value : defaultVal;
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// ─────────────────────────────────────────────
//  Telegram Bot (Webhook mode for Vercel)
// ─────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Set webhook on cold start
(async () => {
  try {
    await bot.setWebHook(`${BASE_URL}/webhook`);
    console.log("✅ Webhook set:", `${BASE_URL}/webhook`);
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
})();

// ── Webhook endpoint ──
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ── Admin check ──
function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

// ── Send message safely ──
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "HTML", ...opts });
  } catch (e) {
    console.error("safeSend error:", e.message);
  }
}

// ─────────────────────────────────────────────
//  /start command
// ─────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId  = String(msg.chat.id);
  const userId  = String(msg.from.id);
  const refCode = match[1].trim().replace("/", "");

  const botOff = await getSetting("botOff", false);
  if (botOff && !isAdmin(userId)) {
    return safeSend(chatId, "🔴 <b>Bot is currently offline.</b>\nPlease check back later.");
  }

  // Force join check
  const reqChannel = await getSetting("requiredChannel", null);
  if (reqChannel) {
    try {
      const member = await bot.getChatMember(reqChannel, userId);
      if (["left", "kicked"].includes(member.status)) {
        return safeSend(chatId, `⚠️ <b>Join our channel first!</b>\n\nChannel: ${reqChannel}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: "📢 Join Channel", url: `https://t.me/${reqChannel.replace("@", "")}` },
              { text: "✅ I Joined", callback_data: "check_join" }
            ]]
          }
        });
      }
    } catch (e) { /* channel check failed, allow */ }
  }

  let user = await User.findOne({ telegramId: userId });
  if (!user) {
    user = await User.create({
      telegramId: userId,
      username:   msg.from.username || "",
      firstName:  msg.from.first_name || "User",
    });

    // Referral credit
    if (refCode && refCode !== userId) {
      const referrer = await User.findOne({ telegramId: refCode });
      if (referrer && !referrer.isBanned) {
        const referAmount = await getSetting("referAmount", 5);
        referrer.balance      += referAmount;
        referrer.referralCount += 1;
        await referrer.save();
        user.referredBy = refCode;
        await user.save();
        await safeSend(refCode, `🎉 <b>New Referral!</b>\n+₹${referAmount} added to your wallet.\nReferred: <b>${user.firstName}</b>`);
      }
    }

    // Welcome — new user
    return safeSend(chatId, `👑 <b>Hey ${user.firstName}! Welcome To Bingo!</b>\n\n━━━━━━━━━━━━━━━\n💰 Earn Real Money by inviting friends!\n💸 Get paid instantly to your UPI!\n━━━━━━━━━━━━━━━\n\n👇 Tap below to get started!`, {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Start Earning Now", web_app: { url: WEBAPP_URL } }]]
      }
    });
  }

  if (user.isBanned) {
    return safeSend(chatId, "🚫 <b>You are banned from Bingo Cash.</b>");
  }

  // Returning user
  safeSend(chatId, `✅ <b>Hey ${user.firstName}! You're All Set!</b>\n\n━━━━━━━━━━━━━━━\n🚀 Tap below to open Bingo!\n💸 Start earning money right now!\n━━━━━━━━━━━━━━━`, {
    reply_markup: {
      inline_keyboard: [[{ text: "💰 Open Bingo Cash", web_app: { url: WEBAPP_URL } }]]
    }
  });
});

// ─────────────────────────────────────────────
//  Callback: check_join
// ─────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = String(query.from.id);
  const data   = query.data;

  if (data === "check_join") {
    const reqChannel = await getSetting("requiredChannel", null);
    if (!reqChannel) return bot.answerCallbackQuery(query.id, { text: "✅ No channel required!" });
    try {
      const member = await bot.getChatMember(reqChannel, userId);
      if (["left", "kicked"].includes(member.status)) {
        return bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined yet!", show_alert: true });
      }
      bot.answerCallbackQuery(query.id, { text: "✅ Verified! Send /start again." });
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: "⚠️ Could not verify. Try again." });
    }
  }
});

// ─────────────────────────────────────────────
//  ADMIN COMMANDS
// ─────────────────────────────────────────────

// ── /addbalance <userId> <amount> ──
bot.onText(/\/addbalance (\S+) (\d+\.?\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, uid, amt] = match;
  const user = await User.findOneAndUpdate({ telegramId: uid }, { $inc: { balance: parseFloat(amt) } }, { new: true });
  if (!user) return safeSend(msg.chat.id, "❌ User not found.");
  safeSend(msg.chat.id, `✅ Added ₹${amt} to <b>${user.firstName}</b>\nNew Balance: ₹${user.balance.toFixed(2)}`);
  safeSend(uid, `💰 <b>Balance Updated!</b>\n+₹${amt} has been added to your wallet.\nCurrent Balance: ₹${user.balance.toFixed(2)}`);
});

// ── /removebalance <userId> <amount> ──
bot.onText(/\/removebalance (\S+) (\d+\.?\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, uid, amt] = match;
  const user = await User.findOne({ telegramId: uid });
  if (!user) return safeSend(msg.chat.id, "❌ User not found.");
  user.balance = Math.max(0, user.balance - parseFloat(amt));
  await user.save();
  safeSend(msg.chat.id, `✅ Removed ₹${amt} from <b>${user.firstName}</b>\nNew Balance: ₹${user.balance.toFixed(2)}`);
});

// ── /setrefer <amount> ──
bot.onText(/\/setrefer (\d+\.?\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("referAmount", parseFloat(match[1]));
  safeSend(msg.chat.id, `✅ Refer amount set to ₹${match[1]} per invite.`);
});

// ── /setmin <amount> ──
bot.onText(/\/setmin (\d+\.?\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("minWithdraw", parseFloat(match[1]));
  safeSend(msg.chat.id, `✅ Minimum withdrawal set to ₹${match[1]}.`);
});

// ── /setmax <amount> ──
bot.onText(/\/setmax (\d+\.?\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("maxWithdraw", parseFloat(match[1]));
  safeSend(msg.chat.id, `✅ Maximum withdrawal set to ₹${match[1]}.`);
});

// ── /addgift <code> <amount> <maxUses> ──
bot.onText(/\/addgift (\S+) (\d+\.?\d*) ?(\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, code, amount, uses] = match;
  try {
    await GiftCode.create({ code: code.toUpperCase(), amount: parseFloat(amount), maxUses: parseInt(uses || 1) });
    safeSend(msg.chat.id, `🎁 Gift code created!\nCode: <code>${code.toUpperCase()}</code>\nAmount: ₹${amount}\nMax Uses: ${uses || 1}`);
  } catch (e) {
    safeSend(msg.chat.id, "❌ Code already exists.");
  }
});

// ── /editgift <code> <amount> <maxUses> ──
bot.onText(/\/editgift (\S+) (\d+\.?\d*) ?(\d*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, code, amount, uses] = match;
  const g = await GiftCode.findOneAndUpdate(
    { code: code.toUpperCase() },
    { amount: parseFloat(amount), ...(uses ? { maxUses: parseInt(uses) } : {}) },
    { new: true }
  );
  if (!g) return safeSend(msg.chat.id, "❌ Gift code not found.");
  safeSend(msg.chat.id, `✅ Gift code updated!\nCode: <code>${g.code}</code>\nAmount: ₹${g.amount}\nMax Uses: ${g.maxUses}`);
});

// ── /deletegift <code> ──
bot.onText(/\/deletegift (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await GiftCode.deleteOne({ code: match[1].toUpperCase() });
  safeSend(msg.chat.id, `🗑️ Gift code <code>${match[1].toUpperCase()}</code> deleted.`);
});

// ── /listgifts ──
bot.onText(/\/listgifts/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const codes = await GiftCode.find({ isActive: true }).limit(20);
  if (!codes.length) return safeSend(msg.chat.id, "No active gift codes.");
  const list = codes.map(g => `• <code>${g.code}</code> — ₹${g.amount} (${g.usedCount}/${g.maxUses})`).join("\n");
  safeSend(msg.chat.id, `🎁 <b>Active Gift Codes:</b>\n\n${list}`);
});

// ── /addchannel <@channel> ──
bot.onText(/\/addchannel (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("requiredChannel", match[1]);
  safeSend(msg.chat.id, `✅ Required channel set to <b>${match[1]}</b>\nUsers must join before using the app.`);
});

// ── /removechannel ──
bot.onText(/\/removechannel/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("requiredChannel", null);
  safeSend(msg.chat.id, "✅ Required channel removed. App is now open to all.");
});

// ── /setpayout <@channel or chatId> ──
bot.onText(/\/setpayout (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("payoutChannel", match[1]);
  safeSend(msg.chat.id, `✅ Payout channel set to <b>${match[1]}</b>`);
});

// ── /setgiftchannel <@channel> ──
bot.onText(/\/setgiftchannel (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await setSetting("giftChannel", match[1]);
  safeSend(msg.chat.id, `✅ Gift code channel set to <b>${match[1]}</b>\nThis will show in the Gift tab.`);
});

// ── /togglewithdraw ──
bot.onText(/\/togglewithdraw/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const current = await getSetting("withdrawOff", false);
  await setSetting("withdrawOff", !current);
  safeSend(msg.chat.id, `✅ Withdrawal is now <b>${!current ? "🔴 OFF" : "🟢 ON"}</b>`);
});

// ── /togglebot ──
bot.onText(/\/togglebot/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const current = await getSetting("botOff", false);
  await setSetting("botOff", !current);
  safeSend(msg.chat.id, `✅ Bot is now <b>${!current ? "🔴 OFFLINE" : "🟢 ONLINE"}</b>`);
});

// ── /ban <userId> ──
bot.onText(/\/ban (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const user = await User.findOneAndUpdate({ telegramId: match[1] }, { isBanned: true }, { new: true });
  if (!user) return safeSend(msg.chat.id, "❌ User not found.");
  safeSend(msg.chat.id, `🚫 <b>${user.firstName}</b> has been banned.`);
  safeSend(match[1], "🚫 <b>You have been banned from Bingo Cash.</b>\nContact support if you think this is a mistake.");
});

// ── /unban <userId> ──
bot.onText(/\/unban (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const user = await User.findOneAndUpdate({ telegramId: match[1] }, { isBanned: false }, { new: true });
  if (!user) return safeSend(msg.chat.id, "❌ User not found.");
  safeSend(msg.chat.id, `✅ <b>${user.firstName}</b> has been unbanned.`);
  safeSend(match[1], "✅ <b>You have been unbanned from Bingo Cash.</b>\nWelcome back!");
});

// ── /userinfo <userId> ──
bot.onText(/\/userinfo (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const user = await User.findOne({ telegramId: match[1] });
  if (!user) return safeSend(msg.chat.id, "❌ User not found.");
  safeSend(msg.chat.id,
    `👤 <b>User Info</b>\n\nID: <code>${user.telegramId}</code>\nName: ${user.firstName}\nUsername: @${user.username || "N/A"}\nBalance: ₹${user.balance.toFixed(2)}\nReferrals: ${user.referralCount}\nUPI: ${user.upiId || "Not linked"}\nBanned: ${user.isBanned ? "Yes 🚫" : "No ✅"}\nJoined: ${user.joinedAt.toDateString()}`
  );
});

// ── /stats ──
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const totalUsers    = await User.countDocuments();
  const bannedUsers   = await User.countDocuments({ isBanned: true });
  const pendingWithdrawals = await Withdrawal.countDocuments({ status: "pending" });
  const totalPaid     = await Withdrawal.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  safeSend(msg.chat.id,
    `📊 <b>Bingo Cash Stats</b>\n\n👥 Total Users: ${totalUsers}\n🚫 Banned: ${bannedUsers}\n⏳ Pending Withdrawals: ${pendingWithdrawals}\n💸 Total Paid: ₹${totalPaid[0]?.total?.toFixed(2) || "0.00"}`
  );
});

// ── /broadcast <message> ──
bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const text   = match[1];
  const users  = await User.find({ isBanned: false }).select("telegramId");
  let sent = 0, failed = 0;
  safeSend(msg.chat.id, `📢 Broadcasting to ${users.length} users...`);
  for (const u of users) {
    try {
      await bot.sendMessage(u.telegramId, `📢 <b>Announcement</b>\n\n${text}`, { parse_mode: "HTML" });
      sent++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 50)); // rate limit
  }
  safeSend(msg.chat.id, `✅ Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
});

// ── /broadcastchannel <@channel> <message> ──
bot.onText(/\/broadcastchannel (\S+) (.+)/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, channel, text] = match;
  try {
    await bot.sendMessage(channel, `📢 <b>Announcement</b>\n\n${text}`, { parse_mode: "HTML" });
    safeSend(msg.chat.id, `✅ Message sent to ${channel}`);
  } catch (e) {
    safeSend(msg.chat.id, `❌ Failed: ${e.message}`);
  }
});

// ── /pendingwithdrawals ──
bot.onText(/\/pendingwithdrawals/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const list = await Withdrawal.find({ status: "pending" }).limit(10).sort({ createdAt: -1 });
  if (!list.length) return safeSend(msg.chat.id, "✅ No pending withdrawals.");
  const text = list.map(w =>
    `• ID: <code>${w._id}</code>\n  User: ${w.telegramId} | ₹${w.amount} → ${w.upiId}`
  ).join("\n\n");
  safeSend(msg.chat.id, `⏳ <b>Pending Withdrawals:</b>\n\n${text}`);
});

// ── /approvewithdraw <withdrawalId> ──
bot.onText(/\/approvewithdraw (\S+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const w = await Withdrawal.findByIdAndUpdate(match[1], { status: "approved" }, { new: true });
  if (!w) return safeSend(msg.chat.id, "❌ Withdrawal not found.");
  safeSend(msg.chat.id, `✅ Withdrawal approved for user ${w.telegramId}: ₹${w.amount} → ${w.upiId}`);
  safeSend(w.telegramId, `✅ <b>Withdrawal Approved!</b>\n\nAmount: ₹${w.amount}\nUPI: ${w.upiId}\n\nPayment will be processed shortly!`);
});

// ── /rejectwithdraw <withdrawalId> <reason> ──
bot.onText(/\/rejectwithdraw (\S+) ?(.*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const [, wid, reason] = match;
  const w = await Withdrawal.findById(wid);
  if (!w) return safeSend(msg.chat.id, "❌ Withdrawal not found.");
  w.status = "rejected";
  await w.save();
  // Refund
  await User.findOneAndUpdate({ telegramId: w.telegramId }, { $inc: { balance: w.amount } });
  safeSend(msg.chat.id, `✅ Withdrawal rejected and ₹${w.amount} refunded to user ${w.telegramId}.`);
  safeSend(w.telegramId, `❌ <b>Withdrawal Rejected</b>\n\nAmount: ₹${w.amount} has been refunded to your wallet.\nReason: ${reason || "Not specified"}`);
});

// ── /adminhelp ──
bot.onText(/\/adminhelp/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  safeSend(msg.chat.id, `
🛠️ <b>Admin Commands</b>

<b>👤 User Management</b>
/addbalance &lt;id&gt; &lt;amt&gt;
/removebalance &lt;id&gt; &lt;amt&gt;
/ban &lt;id&gt;
/unban &lt;id&gt;
/userinfo &lt;id&gt;

<b>💰 Settings</b>
/setrefer &lt;amount&gt;
/setmin &lt;amount&gt;
/setmax &lt;amount&gt;

<b>🎁 Gift Codes</b>
/addgift &lt;code&gt; &lt;amount&gt; [maxUses]
/editgift &lt;code&gt; &lt;amount&gt; [maxUses]
/deletegift &lt;code&gt;
/listgifts
/setgiftchannel &lt;@channel&gt;

<b>📢 Channels</b>
/addchannel &lt;@channel&gt;
/removechannel
/setpayout &lt;@channel&gt;

<b>🔄 Toggles</b>
/togglewithdraw
/togglebot

<b>💸 Withdrawals</b>
/pendingwithdrawals
/approvewithdraw &lt;id&gt;
/rejectwithdraw &lt;id&gt; [reason]

<b>📊 Stats &amp; Broadcast</b>
/stats
/broadcast &lt;message&gt;
/broadcastchannel &lt;@ch&gt; &lt;msg&gt;
  `);
});

// ─────────────────────────────────────────────
//  REST API — Mini App
// ─────────────────────────────────────────────

// Middleware: verify Telegram initData
function verifyTg(req, res, next) {
  // For dev/testing, you can skip verification
  // In production, verify initData hash from Telegram
  next();
}

// ── GET /api/user/:telegramId ──
app.get("/api/user/:telegramId", verifyTg, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) return res.json({ error: "User not found" });
    const referAmount   = await getSetting("referAmount", 5);
    const minWithdraw   = await getSetting("minWithdraw", 50);
    const maxWithdraw   = await getSetting("maxWithdraw", 5000);
    const withdrawOff   = await getSetting("withdrawOff", false);
    const giftChannel   = await getSetting("giftChannel", null);
    res.json({ ...user.toObject(), referAmount, minWithdraw, maxWithdraw, withdrawOff, giftChannel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/register ──
app.post("/api/register", async (req, res) => {
  try {
    const { telegramId, username, firstName, referredBy, deviceHash } = req.body;

    let user = await User.findOne({ telegramId });
    if (user) return res.json({ user, alreadyExists: true });

    // Check device fingerprint abuse
    if (deviceHash) {
      const deviceExists = await User.findOne({ deviceHash });
      if (deviceExists) {
        return res.json({ error: "device_duplicate", message: "Device already registered." });
      }
    }

    user = await User.create({ telegramId, username, firstName, deviceHash });

    // Referral
    if (referredBy && referredBy !== telegramId) {
      const referrer = await User.findOne({ telegramId: referredBy });
      if (referrer && !referrer.isBanned) {
        const referAmount = await getSetting("referAmount", 5);
        referrer.balance       += referAmount;
        referrer.referralCount += 1;
        await referrer.save();
        user.referredBy = referredBy;
        await user.save();
        safeSend(referredBy, `🎉 <b>New Referral!</b>\n+₹${referAmount} added to your wallet!\nReferred: <b>${firstName}</b>`);
      }
    }

    res.json({ user, alreadyExists: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/leaderboard ──
app.get("/api/leaderboard", async (req, res) => {
  try {
    const top = await User.find({ isBanned: false })
      .sort({ referralCount: -1 })
      .limit(10)
      .select("telegramId firstName username referralCount");
    res.json(top);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/redeem-gift ──
app.post("/api/redeem-gift", async (req, res) => {
  try {
    const { telegramId, code } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user || user.isBanned) return res.json({ error: "User not found or banned." });

    const gift = await GiftCode.findOne({ code: code.toUpperCase(), isActive: true });
    if (!gift)              return res.json({ error: "Invalid or expired code." });
    if (gift.usedCount >= gift.maxUses) return res.json({ error: "Code has been fully used." });
    if (gift.usedBy.includes(telegramId)) return res.json({ error: "You have already used this code." });

    gift.usedBy.push(telegramId);
    gift.usedCount += 1;
    if (gift.usedCount >= gift.maxUses) gift.isActive = false;
    await gift.save();

    user.balance += gift.amount;
    await user.save();

    res.json({ success: true, amount: gift.amount, balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/link-upi ──
app.post("/api/link-upi", async (req, res) => {
  try {
    const { telegramId, upiId } = req.body;
    const user = await User.findOneAndUpdate({ telegramId }, { upiId }, { new: true });
    if (!user) return res.json({ error: "User not found." });
    res.json({ success: true, upiId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/withdraw ──
app.post("/api/withdraw", async (req, res) => {
  try {
    const { telegramId, amount } = req.body;

    const withdrawOff = await getSetting("withdrawOff", false);
    if (withdrawOff) return res.json({ error: "Withdrawals are currently disabled." });

    const minWithdraw = await getSetting("minWithdraw", 50);
    const maxWithdraw = await getSetting("maxWithdraw", 5000);

    if (amount < minWithdraw) return res.json({ error: `Minimum withdrawal is ₹${minWithdraw}.` });
    if (amount > maxWithdraw) return res.json({ error: `Maximum withdrawal is ₹${maxWithdraw}.` });

    const user = await User.findOne({ telegramId });
    if (!user || user.isBanned) return res.json({ error: "User not found or banned." });
    if (!user.upiId)            return res.json({ error: "Please link your UPI ID first." });
    if (user.balance < amount)  return res.json({ error: "Insufficient balance." });

    user.balance -= amount;
    await user.save();

    const withdrawal = await Withdrawal.create({ telegramId, amount, upiId: user.upiId });

    // Notify payout channel
    const payoutChannel = await getSetting("payoutChannel", null);
    if (payoutChannel) {
      safeSend(payoutChannel,
        `💸 <b>New Withdrawal Request</b>\n\nID: <code>${withdrawal._id}</code>\nUser: ${user.firstName} (<code>${telegramId}</code>)\nAmount: ₹${amount}\nUPI: ${user.upiId}\n\nApprove: /approvewithdraw ${withdrawal._id}`
      );
    }

    // Notify all admins
    for (const adminId of ADMIN_IDS) {
      safeSend(adminId,
        `💸 <b>New Withdrawal Request</b>\n\nUser: ${user.firstName} (<code>${telegramId}</code>)\nAmount: ₹${amount}\nUPI: ${user.upiId}\n\n/approvewithdraw <code>${withdrawal._id}</code>\n/rejectwithdraw <code>${withdrawal._id}</code>`
      );
    }

    res.json({ success: true, withdrawalId: withdrawal._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/withdrawal-history/:telegramId ──
app.get("/api/withdrawal-history/:telegramId", async (req, res) => {
  try {
    const history = await Withdrawal.find({ telegramId: req.params.telegramId })
      .sort({ createdAt: -1 }).limit(20);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/referral-history/:telegramId ──
app.get("/api/referral-history/:telegramId", async (req, res) => {
  try {
    const users = await User.find({ referredBy: req.params.telegramId })
      .select("firstName username joinedAt").sort({ joinedAt: -1 }).limit(20);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/settings (public) ──
app.get("/api/settings", async (req, res) => {
  try {
    const referAmount  = await getSetting("referAmount",  5);
    const minWithdraw  = await getSetting("minWithdraw",  50);
    const maxWithdraw  = await getSetting("maxWithdraw",  5000);
    const withdrawOff  = await getSetting("withdrawOff",  false);
    const botOff       = await getSetting("botOff",       false);
    const giftChannel  = await getSetting("giftChannel",  null);
    res.json({ referAmount, minWithdraw, maxWithdraw, withdrawOff, botOff, giftChannel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  Serve Mini App HTML
// ─────────────────────────────────────────────
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Bingo Cash is running 🚀" }));

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

module.exports = app;
