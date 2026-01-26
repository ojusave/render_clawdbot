# Render Clawdbot Wrapper (template)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/render_clawdbot)

This repo deploys **Clawdbot** on **Render** with:

- A password-protected **Install Wizard** at `/install`
- The **Clawdbot Control UI** at `/` and `/clawdbot` (proxied, including WebSockets)
- Persistent state via a **Render Persistent Disk** mounted at `/data`
- **Export + Import backups** to migrate between deployments

## Deploy on Render (Blueprint)

**Plan requirement:** This Blueprint is intended to run on Render’s **Standard** plan (paid). It uses a **persistent disk** at `/data`, which requires a paid service. Review Render pricing before deploying: `https://docs.render.com/pricing#services`.

1) Create a new Render service from this repo.
2) Render will detect `render.yaml` and create the web service + disk.
3) During creation, Render will prompt you for:
   - `RENDER_SETUP_PASSWORD` (required)
4) Deploy, then open:
   - `https://<your-service>.onrender.com/install`
   - After install: `https://<your-service>.onrender.com/` or `/clawdbot`

**Install auth**: `/install` uses **Basic Auth**. The password is `RENDER_SETUP_PASSWORD` (username can be anything).

## Persistent paths

This template stores state and workspace on the persistent disk:

- `CLAWDBOT_STATE_DIR=/data/.clawdbot`
- `CLAWDBOT_WORKSPACE_DIR=/data/workspace`

## Environment variables

Required:
- `RENDER_SETUP_PASSWORD` — protects `/install`

Optional (advanced):
- `RENDER_GATEWAY_TOKEN` — gateway admin token (used by the Control UI to authenticate to the gateway). In this template’s `render.yaml` it is **auto-generated** for you. If you override it, keep it stable across deploys.
- `CLAWDBOT_GIT_REF` — Docker build arg to pin the Clawdbot version (tag/branch/commit). (If you change this, update the Docker build configuration accordingly.)

Optional (branding):
- `RENDER_LOGO_FILE` — filename inside `public/` to show in the header (default: `Render logo - Black.jpg`)
- `RENDER_DEPLOY_URL` — URL used by the “Deploy on Render” button (default: `https://render.com/deploy?repo=https://github.com/ojusave/clawdbot`)

Optional (gateway startup tolerance):
- `GATEWAY_READY_TIMEOUT_MS` — how long to wait for the internal gateway to become ready (default: `60000`)
- `GATEWAY_READY_PATH` — readiness path on the internal gateway (default: `/healthz`)
- `GATEWAY_READY_POLL_MS` — poll interval (default: `300`)
- `GATEWAY_READY_REQ_TIMEOUT_MS` — per-request timeout (default: `2000`)

## Endpoints

- `GET /healthz` — Render health check endpoint
- `GET /install` — install wizard (Basic Auth)
- `GET /install/export` — download a backup `.tar.gz` (Basic Auth)
- `POST /install/api/import` — upload a backup `.tar.gz` (Basic Auth)

## Control UI token

The gateway is protected by a token. The wrapper auto-redirects `/` and `/clawdbot` to include `?token=...` so the Control UI can connect reliably.

## Screenshots

<img src="public/UI%20-1.png" alt="Clawdbot on Render UI (screenshot 1)" width="900" />

<img src="public/UI%20-%202%20.png" alt="Clawdbot on Render UI (screenshot 2)" width="900" />

## Troubleshooting

- **WebSocket closes (code 1008) / “proxy headers detected”**: this wrapper strips `Forwarded` / `X-Forwarded-*` headers when proxying to the internal loopback gateway, because forwarding them can make local clients appear “remote behind an untrusted proxy”.

## Contributing

Fixes and improvements are welcome. See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.

