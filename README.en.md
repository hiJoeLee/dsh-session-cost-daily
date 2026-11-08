# dsh-session-cost-daily

**A cost bar for relay users: no balance lookup, just the money.**

It keeps two readings under the composer — **this session** and **today** — plus a small dot that tells you whether the current hour is billed at the peak or off-peak rate. Nothing here calls DeepSeek's official balance API, so it works when you go through a relay gateway.

[中文](README.md)

## What it solves

Most session-cost bars lead with an account-balance reading, which calls an official endpoint. If you route through a relay, that number never arrives — the slot stays blank or throws.

This version drops balance entirely and keeps three things:

- **This session**: the estimated spend of the current session, priced per model, in CNY
- **Today**: everything today adds up to, including sessions you already closed — read from the local session logs, not just the live process
- **Peak/off-peak dot**: orange in the peak window, green off-peak; only shown for deepseek models so it never misleads on other providers

Click either reading for a per-model breakdown of the session and of today. In a narrow window it gives up the turn/step counters first so the money line survives.

## Install

```sh
dsh plugin --profile desktop add dsh-session-cost-daily
```

For the web GUI use `web` instead of `desktop`. Restart DSH and refresh the page afterwards.

## Differences from upstream

Built on [KIDLi1412/dsh-session-cost](https://github.com/KIDLi1412/dsh-session-cost) (MIT):

- Removed the balance query and the low-balance threshold (relay users cannot reach the official balance API)
- Added a cross-session "today" total, including already-closed sessions, read from local logs
- Added the peak/off-peak dot
- Narrow-window mode gives up the turn/step readings first
- Compatibility claims cover the 0.2.x releases

## License

MIT. Original copyright belongs to KIDLi1412; see LICENSE.
