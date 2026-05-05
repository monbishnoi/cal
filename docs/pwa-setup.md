# Web UI And PWA Setup

The Web UI is Cal's default mobile-friendly surface. It works in a browser, can be installed as a PWA, and gives Cal room for richer text and richer UI than messaging channels.

## Local Access

Start Cal:

```bash
npm start
```

Open:

```text
http://localhost:<port>
```

You can print useful local and Tailscale URLs with:

```bash
./setup/setup-pwa.sh
```

To let the script install/start Tailscale where supported:

```bash
./setup/setup-pwa.sh --tailscale
```

The default template listens on `0.0.0.0`, so other devices on the same Wi-Fi can open Cal through your computer's local IP address:

```text
http://YOUR_COMPUTER_IP:<port>
```

## Install As A PWA

On iOS:

1. Open the Cal URL in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch Cal from the home screen.

On Android:

1. Open the Cal URL in Chrome.
2. Tap the install prompt or browser menu.
3. Tap Add to Home Screen or Install App.

## Private Access With Tailscale

Tailscale is the recommended way to use Cal away from the same Wi-Fi network. It creates a private tailnet between your devices and has a free tier for personal use.

1. Run `./setup/setup-pwa.sh --tailscale` on the machine running Cal, or install Tailscale manually.
2. Install Tailscale on your phone or tablet.
3. Sign in to the same tailnet on both devices.
4. Start Cal.
5. Open Cal from mobile using the machine's tailnet IP or MagicDNS name:

```text
http://TAILNET_DEVICE_NAME:<port>
```

Keep the gateway private to your devices. Do not expose it directly to the public internet unless you have added authentication and understand the risk.
