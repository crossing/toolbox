---
name: ibkr-x11
description: Inspect and drive a headless IBKR Gateway profile's X11 display — use when a gateway login is stuck on a Second Factor Authentication dialog and you need to capture it or click Challenge/Response.
---

# ibkr-x11

Resolves the private Xvfb `DISPLAY`/`XAUTHORITY` of an `ibkr-gateway-<profile>`
podman process and runs X11 tooling against it. Replaces the manual dance of
`nix build nixpkgs#xdotool`, grepping `/proc/<pid>/environ`, and exporting env
prefixes by hand.

## Usage

```bash
ibkr-x11 <profile> env                                    # {"ok":true,"display":":102",...}
ibkr-x11 <profile> screenshot /tmp/shot.png               # capture full screen (chmod 600)
ibkr-x11 <profile> screenshot /tmp/2fa.png '^Second Factor Authentication$'
ibkr-x11 <profile> xdotool mousemove 505 765 click 1      # click at screen coordinates
ibkr-x11 <profile> xdotool windowmove <window-id> 0 -240  # pull a tall dialog into view
ibkr-x11 <profile> import -window <window-id> /tmp/w.png  # raw import passthrough
```

`<profile>` is the gateway service profile, e.g. `main-live` or `pension-live`.

## Diagnosing a stuck Second Factor Authentication dialog

1. `ibkr-x11 <profile> screenshot /tmp/ibkr-2fa.png '^Second Factor Authentication$'`
   and inspect the image. `Notification sent` only means Gateway requested an
   IB Key push; it does not prove the phone received it.
2. Dialogs are often taller than the 1080p Xvfb screen — if the action links are
   cut off, find the window id with `xdotool search --name`, move it up with
   `windowmove`, and take a full-screen `screenshot` instead.
3. Inspect the captured image locally before every click; never reuse coordinates
   from an earlier dialog. Click with `xdotool mousemove <x> <y> click 1`.
4. For a missing push, click `Log in with Challenge/Response`, recapture, and hand
   the challenge code to the owner (IBKR Mobile -> Services -> Authenticate).
   Treat the response as short-lived authentication material: never log it.

## Failure modes

- `no_gateway_process`: no `podman run --name ibkr-gateway-<profile>` process is
  running — start the gateway service first.
- `no_display`: the process exists but has no X11 environment; the service is
  probably not running in `xvfb` display mode.
