# Running Overhead on a Raspberry Pi wall display

Tested target: Raspberry Pi 4 + a landscape HDMI display (e.g. Corsair Xeneon
Edge 2560×720 — video over HDMI, separate USB-C power, touch works as a
standard USB HID device). Raspberry Pi OS (Bookworm) with a desktop session.

## 1. Install

```sh
sudo apt install -y nodejs chromium-browser   # Node 18+ required
git clone https://github.com/Diastro/overhead.git ~/overhead
```

## 2. Run the server as a service

`/etc/systemd/system/overhead.service`:

```ini
[Unit]
Description=Overhead flight tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/overhead
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now overhead
curl -s http://localhost:8080/config >/dev/null && echo up
```

## 3. Chromium kiosk on boot

`~/.config/autostart/overhead-kiosk.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Overhead kiosk
Exec=chromium-browser --kiosk --noerrdialogs --disable-restore-session-state --app=http://localhost:8080
```

## 4. Keep the screen awake

```sh
# X11 (Pi OS default desktop): disable blanking in /etc/lightdm/lightdm.conf
#   [Seat:*]
#   xserver-command=X -s 0 -dpms
# Or with raspi-config: Display Options -> Screen Blanking -> No
```

## 5. First boot

On the display, tap **⌂ HOME** and set your location (it's stored in the
browser, per device). Pick a bandwidth mode under **⚙ SETTINGS** if the Pi is
on a metered link, and try the **WALL** density for across-the-room reading.
