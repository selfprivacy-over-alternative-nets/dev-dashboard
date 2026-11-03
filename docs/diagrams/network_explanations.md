## Change requirements
After showing the overview for:
http://localhost:3000/flow.html#setup-map;method=cable;net=0a;reach=tailscale
and explaining which steps ("Setting it up") were missing, I got the feedback it was a bit overwelming.
As a solution I want to go through/build the diagrams up in steps, based on what the user will do and only show the 
components that are relevant for the user at that point in time.

## tailscale

Tailscale Funnel gives your server a free `https://selfprivacy.<tailnet>.ts.net` address that works on any home
network, without opening anything on your router. Diagram:
[setup-map, reach = Tailscale](../../flow.html#setup-map;method=cable;net=0a;reach=tailscale).

### Setting it up
1. **On your computer:** make a Tailscale account and generate an **auth key** (`tskey-auth-…`) on Tailscale's
   Keys page. Leave every option at its default. A key works only once (tick *Reusable* to set up several servers).
2. **The installer installs SelfPrivacy (NixOS) first.** The key is *not* part of the install package. At the end,
   the installer asks you to paste it on your computer and sends it over the cable to the new server, which runs
   `tailscale up --authkey=… --hostname=selfprivacy`.
3. **The server joins your Tailscale account.** It first creates its own secret identity and keeps it on its disk
   (`/var/lib/tailscale/tailscaled.state`). It shows the auth key once, as an entry ticket: Tailscale registers it as
   a new machine and the key is used up. From then on the server proves who it is with its identity file.
4. **The name is not random:** `selfprivacy` (the name the installer gives the server) plus your account's fixed
   tailnet name, so `selfprivacy.tailXXXX.ts.net`.
5. **Switch Funnel on, once,** in your browser. The installer prints the exact link.
6. **Tailscale writes the name in its own fast DNS phonebook.** The entry points to **Tailscale's relay servers**,
   not to your server: your home IP address never appears in public DNS. A brand-new name can take about 10 minutes
   to work everywhere. (Inside your own Tailscale account the same name points to the server's private `100.x`
   address, which only your own devices can use.)

### Steps and components.
<nr>=step
<nr.letter>=which components to show.
<nr.roman letter>how to show it/what to animate in which order.
<nr.nr> The text that is shown in bottom right that describes to the user what is going on in this step. 

0. Create tailscale account.
0.a Your computer icon
0.b tailscale company icon
0.c the internet  (cloud icon)
0.d tunnel betweeen internet and tailscale
0.I a line (edge e4 is drawn) and a mario icon/animation walks/jumps from your computer (or use whatever it uses to move up and down, like sliding down flag pole for down, running along line for horizontal, and climbing up ladder to make it move across the line). it walks to tailscale, creates an account and gets an auth key.
0.II Brings the auth key back to your computer.
0.1 First you make a Tailscale account and get an auth-tk key from tailscale.

1. That is thrown into "your private server" along with the installation light. 
1.a Your new private server.
1.b The cable/connection e_cable between your computer and your private server.
1.c The router
1.d tunnel e_ts_up
1.I the mario runs with the installation light and the key to your new private server
1.II The mario builds/hammers the Selfprivacy installation up, 
1.III After installation, Mario takes the IP nr of the machine with him along with the key and runs from your new private server to the tailscale company (through the tunnel).
1.IV At tailscale, mario uses the key to open a vault which contains another key, then he burns the key that he used to open the vault and runs back with the new key and opens another vault with that new key and gets the domain name and returns to the your private server with the new key and the domain name.
1.1 You give the the 1-time auth key you got from tailscale to your Selfprivacy server and that machine registers itself at Tailscale, where it gets a domain.

2. Tailscale then takes the domain and ip adres and puts it in the fast dns phoneobook.
2.a the DNS fast phonebook 
2.b e3
2.1 Tailscale maintains their own DNS phonebook and stores your Selfprivacy machine's IP with its domain name so others can find it.

3. You give the domain to a friend so you can jitsi meet.
3.a The a friends phone
3.b e_friend
3.c e_ts_friend.
3.1 You gave your tailscale url<> to a friend which then goes to the url, and in the background the dns phonebook helps your friend get to your selfprivacy server (ip) based on the domain name your friend entered.



### When a friend opens the link
Your friend's phone asks the phonebook and gets a Tailscale relay address. It connects to that relay, and the relay
passes the still-encrypted connection on to your server, through the connection your server keeps open to Tailscale.
The encryption ends on your server (it holds the certificate for the name), so the relay can't read the traffic.
Nothing on your router is opened: the server only connects outward.

### Reboot, new home IP, reinstall, expiry
- **Reboot or a new home IP:** the server proves it is the same machine with its identity file, not with the auth
  key. Because the phonebook points to Tailscale's relay, a new home IP changes nothing in the phonebook: the server
  simply reconnects outward.
  - **Gap in this project today:** the installer writes the Tailscale service to `/run`, which is cleared on reboot
    (`install_service` in `tools/add-cloudflare.sh`). After a reboot the site stays offline until you run the finish
    step again. That run finds the identity file, so it needs no new key.
- **Reinstall:** the old key is used up, so you always need a fresh one. Reinstalling wipes the disk and with it the
  identity file, so the server becomes a *new* machine. The old machine is still listed in your account (offline)
  and keeps the name `selfprivacy`, so the new one gets `selfprivacy-1`: a new address, and old links stop working.
  - Today: delete the old machine on Tailscale's Machines page, then join again with a fresh key. The installer's
    name check walks you through this.
  - Planned (round0 R2): carry the identity file into the reinstall, so the server stays the same machine.
- **Login expiry:** a machine joined with a normal (untagged) auth key gets Tailscale's default key expiry: its login
  runs out after 180 days and the site goes offline. Switch off key expiry for the server on Tailscale's Machines
  page (machines joined with a tagged key have it off by default). The installer doesn't do this yet.
- The auth key itself expires after at most 90 days if it is never used. That doesn't affect a server that already
  joined.

Sources: Tailscale docs — [Key expiry](https://tailscale.com/docs/features/access-control/key-expiry),
[Auth keys](https://tailscale.com/docs/features/access-control/auth-keys),
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel); blog —
[Introducing Tailscale Funnel](https://tailscale.com/blog/introducing-tailscale-funnel).

## cloudflare-buy

A Cloudflare Tunnel with a domain you buy gives your server stable addresses (`https://api.yourdomain.org`, plus
`cloud.`, `git.`, `matrix.` and `meet.`) that work on any home network, without opening anything on your router.
The domain costs money every year; Cloudflare itself is free. Diagram:
[setup-map, reach = Cloudflare, name = buy](../../flow.html#setup-map;method=cable;net=0a;reach=cloudflare;name=buy).

### Setting it up
1. **Buy a domain** at a registrar (a shop for domain names, €/yr).
2. **Point it to Cloudflare's phonebook, once, by hand.** Make a free Cloudflare account and add the domain (Free
   plan). Cloudflare shows two nameservers (`….ns.cloudflare.com`). On the registrar's website, replace the
   registrar's nameservers with those two (if DNSSEC is switched on there, switch it off first). From then on
   Cloudflare's phonebook answers for your domain. The switch can take up to a day.
3. **Make a tunnel and copy its token:** on Cloudflare's Tunnels page (Zero Trust ▸ Networks ▸ Tunnels ▸ Create a
   tunnel ▸ Cloudflared), give it a name. Cloudflare shows an install command with a long token (`eyJ…`) in it:
   copy just the token. Unlike a Tailscale key it is not used up, so keep it in your password manager.
4. **The installer bakes the domain in first.** At the start you choose Cloudflare ▸ custom domain and type the
   domain. The server's web server is built for `api.`, `cloud.`, … of exactly that name, so changing it later means
   reinstalling. Then the installer installs SelfPrivacy (NixOS).
5. **At the end, the installer asks you to paste the token** on your computer and sends it over the cable to the
   new server. It installs `cloudflared` there and runs `cloudflared tunnel run --token …`. This connector dials
   *out* to Cloudflare (four connections to at least two Cloudflare data centers) and keeps them open, so the
   router's gates stay shut.
6. **Add the five names to the tunnel, by hand.** In the tunnel's settings, add a public hostname (newer dashboards
   call it a *published application*) for each of `api`, `cloud`, `git`, `matrix` and `meet`. Point each one to
   `https://localhost:443` and switch on *TLS ▸ No TLS Verify*. The installer prints the list.
7. **Cloudflare writes the names in its phonebook by itself:** each hostname you add becomes a record pointing to
   your tunnel. The phonebook answers with **Cloudflare's relay addresses**, not your server's, so your home IP
   address never appears in public DNS.

### When a friend opens the link
Your friend's phone asks the phonebook and gets a Cloudflare address. It connects to the nearest Cloudflare data
center, which **ends the encryption there**, using Cloudflare's own free certificate for your domain. Cloudflare
then sends the request through one of the connections your server keeps open. `cloudflared` passes it to the
server's web server, which picks the service by name. Unlike Tailscale Funnel, **Cloudflare can read everything
that passes through**: logins, files, messages. (Between Cloudflare and your server the traffic is encrypted
again, but with the server's self-signed certificate, which nobody checks. That is the *No TLS Verify* switch.)
Nothing on your router is opened. Cloudflare's free plan refuses any single request over 100 MB, and its terms
let it limit sites that mostly serve video or other large files.

### Reboot, new home IP, reinstall, expiry
- **Reboot or a new home IP:** the tunnel belongs to the token, not to your address, and the phonebook points to
  Cloudflare, so nothing in the phonebook changes. The connector simply dials out again.
  - **Gap in this project today:** as with Tailscale, the installer writes the `cloudflared` service to `/run`,
    which is cleared on reboot (`install_service` in `tools/add-cloudflare.sh`). After a reboot the site stays
    offline until you run the finish step again and paste the same token.
- **Reinstall:** the token is still valid. The tunnel, its five names and the phonebook records all stay in your
  Cloudflare account. Paste the same token at the end: the addresses stay the same and old links keep working.
- **A leaked token** lets someone else run your tunnel and serve pages under your names. Refresh the token on the
  tunnel's page (the old one can then no longer connect) and run the finish step with the new one.
- **Expiry:** renew the domain every year at the registrar, or it lapses and someone else can buy it. Cloudflare
  renews its certificate by itself.

Sources: Cloudflare docs: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
[Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/) (four connections),
[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/),
[Tunnel DNS records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/),
[Change your nameservers](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/),
[Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/),
[Error 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)
(upload limit per plan); [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)
(video and large files).

## cloudflare-trycf

A Cloudflare quick tunnel gives your server a free, random `https://<random-words>.trycloudflare.com` address. It
needs no account, no domain and nothing on your router. It is meant for testing, because the name changes every
time the tunnel restarts. Diagram:
[setup-map, reach = Cloudflare, name = trycf](../../flow.html#setup-map;method=cable;net=0a;reach=cloudflare;name=trycf).

### Setting it up
1. **Nothing to make beforehand:** no account, no domain, no key. In the installer choose Cloudflare ▸ free
   `*.trycloudflare.com`.
2. **The installer installs SelfPrivacy (NixOS) with a placeholder name** (like `selfprivacy.box`). The public name
   doesn't exist yet: Cloudflare picks it at the end.
3. **At the end, the installer installs `cloudflared` on the server** over the cable and starts a quick tunnel
   (`cloudflared tunnel --url https://localhost:443`). Like the paid route, it dials out to Cloudflare, so the
   router's gates stay shut.
4. **Cloudflare writes a random name in its phonebook.** `trycloudflare.com` is Cloudflare's own domain, and the
   entry points to Cloudflare's relay. The server writes the name in its log, and the installer reads it from there
   and prints it.
5. **One name only:** the installer aims the tunnel at the app's API (`api.selfprivacy.box` on the server), so the
   app connects to the bare name (`--apex`). The cloud, git, matrix and meet services can't be reached this way.

### When a friend opens the link
The path is the same as with the paid route. The phone gets a Cloudflare address from the phonebook. Cloudflare ends
the encryption with its own `*.trycloudflare.com` certificate, so it **can read the traffic**. It sends the request
through the connection your server keeps open, and `cloudflared` passes it to the API (self-signed certificate, not
checked). Cloudflare's limits: at most 200 requests at once (more get an error), no Server-Sent Events, and no
uptime guarantee.

### Reboot, new home IP, reinstall, expiry
- **A restart means a new name.** The name belongs to the running `cloudflared`. Whenever it starts again (reboot,
  crash, a service restart), Cloudflare hands out a new random name. Old links stop working, and the app has to be
  pointed at the new name. A new home IP on its own usually changes nothing, because the running connector just
  dials out again.
  - **Gap in this project today:** the service is written to `/run` (`install_service` in
    `tools/add-cloudflare.sh`). After a reboot there is no tunnel at all until you run the finish step again, and
    that run gets a new name.
- **Reinstall:** a new name, as with any restart.
- **Expiry:** without an account there is nothing to renew, but nothing is kept either: Cloudflare can end a quick
  tunnel at any time. For an address friends rely on, use a domain ([cloudflare-buy](#cloudflare-buy)).

Sources: Cloudflare docs: [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## ipv6-duckdns

Direct IPv6 with a free DuckDNS name gives your server `https://api.yourname.duckdns.org` with **no company in
between**: friends connect straight to your server over IPv6. It needs IPv6 from your internet provider, an opening
in your router's IPv6 fire wall, and friends who have IPv6 too. It only suits a server at home. Diagram:
[setup-map, reach = Direct IPv6, name = DuckDNS](../../flow.html#setup-map;method=cable;net=0a;reach=ipv6;name=duckdns).

### Setting it up
1. **On your computer:** sign in at duckdns.org (with an existing GitHub, Google, … account), claim a free name
   `yourname.duckdns.org` and copy your account's **token**. The token is not used up, so keep it in your password
   manager.
2. **The installer bakes the name in first.** Choose Direct IPv6 ▸ free ▸ DuckDNS (in `--expert-mode`) and type
   the name. The server's web server is built for `api.`, `cloud.`, … of exactly that name. Then the installer
   installs SelfPrivacy (NixOS).
3. **At the end, the installer looks for the server's public IPv6 address** on the network the server ended up on.
   If there is none, it stops and tells you to use Cloudflare. It asks for the DuckDNS token and starts a small loop
   on the server (`/root/duckdns-aaaa.sh`) that **sends the server's current IPv6 address to DuckDNS every 5
   minutes**: your server updates its own phonebook entry. DuckDNS answers for every name under yours, so
   `api.yourname.duckdns.org` gets the same address.
4. **Open the fire wall in your router, once, by hand:** allow incoming TCP 443 to the server's IPv6 address (plus
   TCP 80, but only for a certificate via HTTP-01, see the gaps below). The installer prints the address. This is
   not a port-forward: IPv6 has no NAT, so the server's address can be reached from the whole internet as soon as
   the fire wall lets visitors through. On IPv6 the router has no receptionist, only the fire wall. Most home
   routers block all incoming IPv6 until you do this.
5. **The phonebook entry is your server's own address** (like `2001:db8::1`). Anyone can look it up, and it shows
   your internet provider and roughly your region. (With Tailscale or Cloudflare the phonebook shows their relay
   instead.)

### When a friend opens the link
Your friend's phone asks DuckDNS and gets your server's IPv6 address. It connects **straight to your server**:
across the internet, through the opening in your router's fire wall, to the server's web server, which ends the
encryption with its own certificate. No relay sees the traffic. A friend on an IPv4-only network (still many
offices, hotels and some providers) gets no usable address and can't open the link.

### Gaps in this project today
- **The web server only listens on IPv4.** Every site on the server is set to `0.0.0.0:443`
  (`selfprivacy-altnet-deployer/clearnet-https.nix`, and the core modules in
  `Manager-Ubuntu-SelfPrivacy-Over-Tor/backend/nixos/`). So even with the fire wall open, a friend's IPv6
  connection is refused. Fix: also listen on `[::]:443`. No test result for an IPv6 route has been recorded yet.
- **No automatic certificate.** The server uses a self-signed certificate, so browsers show a warning. The only
  exception is a Let's Encrypt certificate for exactly this name, made on your computer and put into the install
  (`cert-source.local` = `external-le`), which you then renew by hand every 90 days. Nothing on the server asks
  Let's Encrypt for a certificate, and port 80 is closed in the server's own firewall, so opening port 80 on the
  router does nothing yet. (`tools/add-cloudflare.sh` and req 137 say the server gets its own Let's Encrypt
  certificate. It doesn't.) For DuckDNS the natural fix is DNS-01 with the same token, through DuckDNS's TXT
  record. DuckDNS holds one TXT record at a time, so that means one name per step.
- **The updater may publish a temporary address.** It takes the first global IPv6 address the server lists. The
  server also makes temporary "privacy" addresses (NixOS `networking.tempAddresses = "default"`), which are
  normally listed first and replaced about once a day. If it picks one of those, the phonebook entry and your fire
  wall opening keep going stale. It should skip temporary addresses (`box_global_ipv6` in `tools/net_lib.sh` picks
  the same way).

### Reboot, new home IP, reinstall, expiry
- **Reboot:** on the same network the server normally keeps its IPv6 address.
  - **Gap in this project today:** the updater's service is written to `/run` (`install_service` in
    `tools/add-cloudflare.sh`), which is cleared on reboot. The script stays in `/root`, but nothing starts it until
    you run the finish step again. If the address changed in the meantime, the phonebook still points at the old
    one.
- **New home IPv6 address:** some providers change your IPv6 range now and then, for example after the router
  restarts. The updater sends the new address within 5 minutes, but many routers tie the fire wall opening to the
  old address, so you have to open it again.
- **Moving the server:** on another network (café, office) the server gets a different address, and you can't open
  that router's fire wall. This route is for a server at home only.
- **Reinstall:** the name and the token stay in your DuckDNS account, so use them again. The server probably gets
  a new IPv6 address (it is derived from a secret made during the install). The updater fixes the phonebook, but
  you have to open the router's fire wall again for the new address.
- **Expiry:** DuckDNS is run by volunteers on donations, with no uptime guarantee. A Let's Encrypt certificate
  lasts 90 days, and today it is renewed by hand (see the gaps).

Sources: [DuckDNS spec](https://www.duckdns.org/spec.jsp) (`ipv6=` update, shared TXT record); Let's Encrypt:
[Challenge types](https://letsencrypt.org/docs/challenge-types/).

## ipv6-buy

Direct IPv6 with a domain you buy gives your server `https://api.yourdomain.org` (and the other four names) with
no company in between, like [ipv6-duckdns](#ipv6-duckdns). The difference: you have your own name, and you edit
the phonebook by hand. Diagram:
[setup-map, reach = Direct IPv6, name = buy](../../flow.html#setup-map;method=cable;net=0a;reach=ipv6;name=buy).

### Setting it up
1. **Buy a domain** at a registrar (€/yr). The registrar's phonebook (its DNS) holds your records, and you edit
   them by hand on its website.
2. **The installer bakes the domain in first.** Choose Direct IPv6 ▸ paid (in `--expert-mode`) and type the
   domain. Then the installer installs SelfPrivacy (NixOS).
3. **At the end, the installer looks for the server's public IPv6 address** and prints it. If there is none, it
   stops and tells you to use Cloudflare. For this route nothing runs on the server to update the phonebook.
4. **Write the address in the registrar's phonebook, by hand:** an AAAA record (name → IPv6 address) for
   `api.yourdomain.org` pointing to the server's IPv6 address, and the same for `cloud.`, `git.`, `matrix.` and
   `meet.`. Some registrars allow one wildcard record `*.yourdomain.org` instead.
5. **Open the fire wall in your router, once, by hand:** allow incoming TCP 443 to the server's IPv6 address, as
   with DuckDNS. This is not a port-forward: on IPv6 the router has no receptionist.
6. **The phonebook entry is your server's own address.** Anyone can look it up, and it shows your provider and
   roughly your region.

### When a friend opens the link
Your friend's phone asks the registrar's phonebook and gets your server's IPv6 address. It connects straight to
your server through the opening in the router's fire wall, and the server ends the encryption with its own
certificate. No relay sees the traffic. A friend on an IPv4-only network can't open the link.

### Gaps in this project today
- The first two gaps of [ipv6-duckdns](#ipv6-duckdns) apply here too: the web server only listens on IPv4, and
  there is no automatic certificate. With a bought domain, DNS-01 works through the registrar's DNS API, if it has
  one, and HTTP-01 works over port 80, which the server doesn't answer yet.
- **The installer prints only one record**, for the bare `yourdomain.org`. But the app connects to
  `api.yourdomain.org`, and the other services live on `cloud.`, `git.`, `matrix.` and `meet.`. Set all five
  (step 4). The port-forward route already prints all five.

### Reboot, new home IP, reinstall, expiry
- **Reboot:** this route has nothing to restart (no tunnel, no updater), and the server normally keeps its
  address.
- **New home IPv6 address:** nothing updates the phonebook. Edit the five records by hand, and open the fire wall
  again if your router tied the opening to the old address. Until then friends get the old address, and phonebooks
  along the way may remember it for the record's lifetime (often an hour or more).
- **Moving the server:** home only, as with DuckDNS.
- **Reinstall:** the domain stays yours at the registrar. The server probably gets a new IPv6 address, so edit the
  records and the fire wall opening.
- **Expiry:** renew the domain every year at the registrar, or it lapses and someone else can buy it. The Let's
  Encrypt certificate lasts 90 days, and today it is renewed by hand.

Sources: Let's Encrypt: [Challenge types](https://letsencrypt.org/docs/challenge-types/).
