A. I don't quite understand what is in the selfprivacy altnet deployer, or how it works, what is synced and what not. Can you clarify that in the visualisation of the Selfprivacy-altnet-deployer (flake+/netboot -- New block?

B. Also, I wonder what a userfriendly way is to show what the user should do to make it work in the arbitrary setup (e.g. different hardware, different network, different wifi etc.). I thought perhaps a website where you enter the data. Also how should the code easily handle multiple setups for a single user? 

C. How can I see which parts need improvement to generalise them? Are there parts that cannot be automated that are still non-trivial?

D. Is there a way to postquantum encrypt the sensitive data, have just 1 password that encrypts decrypts the flake, such that it can be pushed to a private repo?

## Answers

A. **What it is / how it works / what's synced.**
The deployer is a NixOS flake that BUILDS the SelfPrivacy-over-alt-nets server and INSTALLS it onto a
device with `nixos-anywhere`; `~/netboot` is a SEPARATE PXE server that lets an empty device boot an
in-RAM installer for nixos-anywhere to install into. Contents (= the diagram's varies-by subsets):
- **generic:** `flake.nix` (pins the backend fork via `spbackend`, wires `selfprivacy-tor-core.nix` +
  disko), `netboot.nix` (in-RAM installer, authorises the deploy key), `nix-gc-path.nix` (adds `nix`
  to the API service PATH so GC doesn't hang).
- **hardware:** `disko.nix` (disk layout by-id) + `~/netboot/dnsmasq.conf` MAC pin — auto-adapted by
  retarget / auto-retarget.
- **per-user:** `host.nix` (hostname/net/ssh key/recovery pw), `weersurf-https.nix` (domain + cert
  source), `secrets-seed.nix` (writes `userdata.json`; the API token is generated ON the box, never in
  the nix store).
- **env workaround:** `renew/` (theory7 DNS-01 via Selenium, because theory7 has no DNS API).
- **`state/` — the secrets, NOT synced:** `state/extra/` is the `--extra-files` tree injected at
  install (`secrets.json` token + LE cert + the wifi `.nmconnection`); `keepass/` per-deploy DB;
  `wifi/` PSKs. `ca/` = self-signed CA fallback.

Install = `nixos-anywhere --flake <deployer>#box --target-host root@<ip> --extra-files state/extra`
→ builds (backend + disko + host + domain + secrets-seed), partitions+installs, copies `state/extra`
onto the box. **Synced:** everything EXCEPT `state/` is rsync-mirrored to the private `deployments`
repo (`rsync --exclude state`); `state/` (all secrets) is never synced/pushed. `~/netboot` is local.
(The diagram's deployer block now marks `state/` as not-synced + shows the install command.)

B. **User-friendly arbitrary setup + multiple setups per user.**
Split the deployer into a GENERIC core (no edits) + a tiny PER-INSTANCE input. After the auto bits
(disk → retarget, networking → DHCP/NM, token → on-box) the only things a user must supply are:
**domain, wifi (SSID+PSK), and confirm the disk.** That small surface is what a front-end collects:
- A **CLI wizard** (`dash new-deploy` / an `init` prompt) is most reproducible (no server); a **website
  form** is friendliest — enter domain/wifi → it emits the per-instance file + the exact install
  command (do the secret entry client-side; never store PSK/tokens server-side). SelfPrivacy upstream
  uses a mobile app for this same provisioning step.
- **Multiple setups/one user:** parametrise by INSTANCE — `instances/<name>.json` (domain, wifi, target
  MAC, disk) + a generic flake that generates `nixosConfigurations.<name>` from it; secrets per instance
  in `state/<name>/` (not synced). Add a box = add one instance file (via the wizard); zero code
  duplication; the installer takes `--instance <name>`.

C. **What to generalise / what can't be automated (but is non-trivial).**
Automatable, not yet done: `host.nix` hardware bits (hardcoded initrd modules + `kvm-intel`) → use
nixos-anywhere `--generate-hardware-config` (facter) to detect per device; domain/wifi → make inputs
(B). Already auto: disko (retarget), networking (DHCP/NM), token (on-box).
**Can't be fully automated for arbitrary users — and all live OUTSIDE the box:**
1. **Trusted TLS cert** — needs a DNS provider with an API (DNS-01) or a reachable port 80 (HTTP-01);
   theory7 has neither → the Selenium `renew/` hack. Generic fix: require a DNS provider with an API
   (Cloudflare/deSEC/…), or skip clearnet and use **.onion** (no cert, works behind any NAT — the
   project's whole premise).
2. **Public reachability** — ISP CGNAT, router port-forward 443, dynamic WAN IP; not automatable across
   routers/ISPs. `.onion` or an outbound tunnel sidesteps it.
3. **DNS A-record → box** — only automatable if the provider has an API; else manual / dynamic-DNS.
4. **Firmware / netboot quirks** on exotic hardware (secure boot, old-UEFI UKI handoff) — mostly solved,
   per-target edge cases remain (handover6).
→ The irreducible hard part is the user's **network/DNS/cert/reachability**, not the box. Defaulting to
`.onion` removes most of it.

D. **One-password, post-quantum encryption of the secrets, pushable to a private repo.**
You don't need PQ *asymmetric* for "one password": a passphrase → KDF → **symmetric** cipher is already
quantum-resistant (Grover only halves it; AES-256/ChaCha20-256 → 128-bit, safe). So:
- Simplest: **`age -p`** (passphrase: scrypt + ChaCha20-Poly1305) over a tar of `state/` → commit
  `state.age` to the private repo (keep raw `state/` git-ignored; only the blob is pushed). Deploy:
  `age -d state.age | tar -xC <deployer>`. One password; never stored.
- Integrated: **sops-nix** — secrets stay encrypted in git, decrypted at activation on the box, via a
  single (passphrase-protected) age key. More moving parts but idiomatic for NixOS.
- True PQ *asymmetric* (ML-KEM/Kyber) exists as experimental hybrid `age` plugins, but it's overkill —
  the single-password case is inherently symmetric, which is already PQ-adequate.
Recommend `age -p` on the `state/` bundle (one password, symmetric = PQ-OK, trivially pushable), or
sops-nix if you want on-box runtime decryption.