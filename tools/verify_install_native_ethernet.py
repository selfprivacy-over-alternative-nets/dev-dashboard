#!/usr/bin/env python3
"""
install.native-ethernet verifier — proves the deployed box is reachable over the
requested transport and serving validly.

Transports (--transport):
  https  (default)  PUBLIC domain, from ANYWHERE, any device: api.<domain> must resolve
                    via PUBLIC DNS to a PUBLIC/routable IP (NOT a LAN/private address and
                    NOT via /etc/hosts), be reachable on :443 over the internet, present a
                    system-trusted (Let's Encrypt) cert, and accept the API token.
  onion             Reachable over Tor from anywhere (SOCKS 127.0.0.1:9050), token accepted.

Takes the required data up front, checks it's present + well-formed, then verifies against
the target. Run it from OFF the LAN (e.g. mobile hotspot) to truly prove "from anywhere".

Usage:
  verify_install_native_ethernet.py --transport https --domain weersurf.nl \
      [--token <64hex>] [--ssh-key ~/.ssh/pcname_ed25519]
  verify_install_native_ethernet.py --transport onion --onion <56>.onion [--token <64hex>]

Exit 0 iff every REQUIRED check passes.
"""
import argparse, ipaddress, json, re, shutil, socket, ssl, subprocess, sys

G="\033[32m"; R="\033[31m"; Y="\033[33m"; Z="\033[0m"
fails=0; warns=0
def ok(m): print(f"{G}PASS{Z} {m}")
def bad(m):
    global fails; fails+=1; print(f"{R}FAIL{Z} {m}")
def warn(m):
    global warns; warns+=1; print(f"{Y}WARN{Z} {m}")
def sec(m): print(f"\n=== {m} ===")

def sh(cmd, timeout=45):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def is_public_ip(ip):
    try: o=ipaddress.ip_address(ip)
    except ValueError: return False
    return not (o.is_private or o.is_loopback or o.is_link_local or o.is_reserved
                or o.is_multicast or o in ipaddress.ip_network("100.64.0.0/10"))  # CGNAT

def curl(url, token=None, socks=None, insecure=False, timeout=45):
    c=["curl","-s","--max-time",str(timeout),"-w","\n%{http_code}"]
    if socks: c+=["--socks5-hostname",socks]
    if insecure: c+=["-k"]
    if token: c+=["-H","Authorization: Bearer "+token]
    c+=[url]
    r=sh(c,timeout+5); out=r.stdout.rsplit("\n",1)
    body=out[0] if len(out)>1 else ""
    code=out[-1].strip() if out else ""
    return code, body

def graphql(base, query, token=None, socks=None, insecure=False):
    c=["curl","-s","--max-time","45","-X","POST",base+"/graphql",
       "-H","Content-Type: application/json","-d",json.dumps({"query":query})]
    if socks: c+=["--socks5-hostname",socks]
    if insecure: c+=["-k"]
    if token: c+=["-H","Authorization: Bearer "+token]
    return sh(c).stdout

def check_https(domain, token, ssh_key, api_sub):
    fqdn=f"{api_sub}.{domain}"
    sec("1. required data present")
    if not domain: bad("missing --domain"); return
    ok(f"domain={domain}" + (f" token=<{len(token)} chars>" if token else " (no token given)"))

    sec("2. data valid (format)")
    (ok if re.fullmatch(r"(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}",domain) else bad)(f"domain '{domain}' well-formed")
    if token: (ok if re.fullmatch(r"[0-9a-f]{64}",token) else bad)("token is 64 hex chars")

    sec("3. resolves via PUBLIC DNS to a PUBLIC IP (works from anywhere, no LAN, no /etc/hosts)")
    # /etc/hosts must not shadow it
    try: hosts=open("/etc/hosts").read()
    except OSError: hosts=""
    overridden=set()
    for line in hosts.splitlines():
        line=line.split("#",1)[0].strip()
        if not line: continue
        toks=line.split()  # ip host1 host2 ...
        for h in toks[1:]:
            if h==domain or h==fqdn: overridden.add(h+" -> "+toks[0])
    if overridden:
        bad(f"/etc/hosts overrides {sorted(overridden)} — a client-only redirect, NOT public DNS. Remove it.")
    else:
        ok("no /etc/hosts override for the domain (resolution is real public DNS)")
    pub_ips=set()
    if shutil.which("dig"):
        for res in ("1.1.1.1","8.8.8.8"):
            got=sh(["dig","+short","@"+res,fqdn,"A"],10).stdout.split()
            got=[x for x in got if re.fullmatch(r"[0-9.]+",x)]
            if got: pub_ips.update(got); ok(f"{res}: {fqdn} -> {got}")
            else: bad(f"{res}: NO public A record for {fqdn}")
    else:
        warn("dig not installed; using system resolver only")
        try: pub_ips.update(ai[4][0] for ai in socket.getaddrinfo(fqdn,443,proto=socket.IPPROTO_TCP))
        except socket.gaierror: bad(f"cannot resolve {fqdn}")
    target=None
    for ip in pub_ips:
        if is_public_ip(ip): ok(f"{fqdn} points to PUBLIC IP {ip}"); target=ip
        else: bad(f"{fqdn} points to {ip} which is PRIVATE/non-routable — not reachable from anywhere (LAN-only)")
    if not target: bad("no public IP for the domain — set an A record to the box's PUBLIC IP (+ open :443)");

    sec("4. reachable on :443 over the internet")
    if target:
        try:
            with socket.create_connection((target,443),timeout=8): ok(f"TCP {target}:443 reachable from here")
        except OSError as e: bad(f"{target}:443 not reachable over the internet ({e}) — open/forward port 443 to the box")

    sec("5. system-trusted TLS (Let's Encrypt, no CA import) via real DNS")
    code,body=curl(f"https://{fqdn}/api/version")   # no -k, no --resolve: real DNS + system trust
    if code=="200" and '"version"' in body: ok(f"https://{fqdn}/api/version -> {body.strip()} (trusted)")
    elif code=="000": bad(f"could not establish trusted TLS to {fqdn} (unreachable or cert not trusted)")
    else: bad(f"unexpected response {code}: {body[:120]}")
    try:
        raw=socket.create_connection((target or fqdn,443),timeout=8)
        cert=ssl.create_default_context().wrap_socket(raw,server_hostname=fqdn).getpeercert(); raw.close()
        org=dict(x[0] for x in cert.get("issuer",[])).get("organizationName","?")
        sans=[v for k,v in cert.get("subjectAltName",()) if k=="DNS"]
        (ok if "Encrypt" in org or "Let" in org else warn)(f"issuer {org}")
        (ok if any(s==fqdn or s=="*."+domain for s in sans) else bad)(f"cert SAN covers {fqdn}")
        ok(f"cert valid until {cert.get('notAfter')}")
    except Exception as e: warn(f"cert inspect: {e}")

    sec("6. API token accepted")
    if token:
        no=graphql(f"https://{fqdn}","{api{devices{creationDate}}}")
        yes=graphql(f"https://{fqdn}","{api{devices{creationDate}}}",token=token)
        try:
            (ok if "auth" in no.lower() else warn)("unauthenticated request rejected")
            (ok if (json.loads(yes).get("data",{}).get("api",{}) or {}).get("devices") is not None else bad)("token accepted by target")
        except Exception as e: bad(f"token check: {e} ({yes[:100]})")
    else: warn("no --token given; skipping auth check")

    if ssh_key and target:
        sec("7. optional SSH cross-check")
        base=["ssh","-i",ssh_key,"-o","BatchMode=yes","-o","StrictHostKeyChecking=no",
              "-o","UserKnownHostsFile=/dev/null","-o","ConnectTimeout=6",f"root@{target}"]
        hn=sh(base+["hostname"],15).stdout.strip()
        (ok if hn else warn)(f"ssh hostname={hn or '(unreachable — fine if SSH not exposed publicly)'}")

def check_onion(onion, token):
    sec("1. required data present");
    if not onion: bad("missing --onion"); return
    ok(f"onion={onion}")
    sec("2. data valid")
    (ok if re.fullmatch(r"[a-z2-7]{56}\.onion",onion) else bad)("onion is a valid v3 address")
    sec("3. Tor SOCKS available")
    try:
        with socket.create_connection(("127.0.0.1",9050),timeout=4): ok("SOCKS 127.0.0.1:9050 up")
    except OSError: bad("no Tor SOCKS on 9050 — start tor first"); return
    sec("4. reachable over Tor from anywhere")
    code,body=curl(f"https://{onion}/api/version",socks="127.0.0.1:9050",insecure=True,timeout=60)
    if code=="200" and '"version"' in body: ok(f"onion /api/version -> {body.strip()}")
    else: bad(f"onion not reachable (HTTP '{code}') — box offline or HS not published")
    sec("5. API token accepted over Tor")
    if token:
        yes=graphql(f"https://{onion}","{api{devices{creationDate}}}",token=token,socks="127.0.0.1:9050",insecure=True)
        try: (ok if (json.loads(yes).get("data",{}).get("api",{}) or {}).get("devices") is not None else bad)("token accepted over Tor")
        except Exception as e: bad(f"token check: {e}")
    else: warn("no --token; skipping auth check")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--transport",choices=["https","onion"],default="https")
    ap.add_argument("--domain"); ap.add_argument("--token"); ap.add_argument("--ssh-key")
    ap.add_argument("--onion"); ap.add_argument("--api-sub",default="api")
    a=ap.parse_args()
    print(f"# transport = {a.transport}")
    if a.transport=="https": check_https(a.domain,a.token,a.ssh_key,a.api_sub)
    else: check_onion(a.onion,a.token)
    sec("summary")
    label=f"install.native-ethernet [{a.transport}]"
    if fails==0: print(f"{G}{label}: VERIFIED{Z} ({warns} warning(s))"); return 0
    print(f"{R}{label}: {fails} check(s) FAILED{Z} ({warns} warning(s))"); return 1

if __name__=="__main__": sys.exit(main())
