## A. Configure Router
Maybe use Openrouter.

## B. Use Cloudflare with some domain.

Cloudflare **Tunnel** exposes the box on the public internet **without touching the router**.
`cloudflared` runs on the box and makes an *outbound* HTTPS/QUIC connection to Cloudflare's
edge; inbound traffic is served back down that connection. This sidesteps the exact blocker we
hit before (double-NAT behind a third party's UniFi UCG — no port-forward, no UPnP, no admin on
the upstream device). **No `:443` port-forward and no router login are required.**

How it works in DNS:

- **Named tunnel (stable `weersurf.nl`):** the tunnel has a UUID; you create DNS records of the
  form `<name>.weersurf.nl CNAME <uuid>.cfargotunnel.com` (proxied). Cloudflare terminates TLS
  at its edge with a trusted cert for the hostname and forwards to `localhost:443` on the box.
  **Requirement:** the `weersurf.nl` zone must live in a Cloudflare account — i.e. move the
  domain's **nameservers to Cloudflare** first (migrate the mail records to CF DNS and **disable
  DNSSEC at theory7** before the NS switch, or resolution breaks). Config:
  `cloudflared tunnel create weersurf`, map hostnames in `~/.cloudflared/config.yml`
  (`ingress: - hostname: api.weersurf.nl / service: https://localhost:443`), run as a systemd
  service on the box. Free on Cloudflare's free plan.

- **Quick tunnel (free, temporary, zero DNS/router config):**
  `cloudflared tunnel --url https://localhost:443`
  prints a **random `https://<random>.trycloudflare.com`** URL, served with a valid Cloudflare
  cert — **no Cloudflare account, no domain, no DNS edits, no router changes at all.** Point the
  app at it with `--dart-define=HTTPS_DOMAIN=<random>.trycloudflare.com`. Caveat: the hostname is
  ephemeral (new one every run) and is not `weersurf.nl`, so it's for throwaway public tests, not
  a stable deployment.

### Can you get a free (temporary) domain to use with the tunnel, so no router config is needed?

**Yes — the quick tunnel above already gives you a free, working, publicly-trusted hostname
(`*.trycloudflare.com`) with no account and no router setup.** That is the simplest "it just
works from anywhere" path and is ideal for temporary testing. The only limitations: the name is
random and changes each run, and the TLS SAN is the trycloudflare hostname (set `HTTPS_DOMAIN`
to it; it will not match `weersurf.nl`).

If you need a **stable** name, you need a domain in a Cloudflare zone (named tunnel above).
Truly-free permanent domains are largely gone (Freenom `.tk/.ml/.ga` is effectively dead), so
the realistic options are: (1) keep using `weersurf.nl` by moving its NS to Cloudflare, or
(2) register a cheap domain (~€1–10/yr) onto a free Cloudflare account. Either way the tunnel
itself is free and needs no router access.
