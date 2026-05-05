# Telegram Setup

Telegram lets you message Cal through your own private bot.

## Create A Bot

1. Open Telegram and talk to BotFather.
2. Create a new bot and copy the token.
3. Put the token in `config/.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
```

## Allow One Chat

Set your allowed chat ID in `config/user.json`:

```json
{
  "telegram": {
    "enabled": true,
    "chatId": "YOUR_TELEGRAM_CHAT_ID"
  }
}
```

Cal rejects messages from any other chat ID.

## Start

```bash
npm start
```

If Telegram is not configured, Cal skips the channel.

