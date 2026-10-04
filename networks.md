# Network setups (`--on`)

States how the installation is done w.r.t. the network setup.


## vm-local
VirtualBox VM on this host (`build-and-run.sh`). No external wiring.

---

## lan-setup-0* — direct cabl to target, no router, netboot install
```
+--------+  ethernet   +--------+
| laptop |------------>| target |   target: 192.168.100.x
+--------+             +--------+
```
Install is identical over the cable. Variants differ only in the target's **post-install**
connectivity:

| id | after install, the cable is… | wifi config |
|----|------------------------------|-------------|
| lan-setup-0a | replugged into router R → target gets its IP from R | none |
| lan-setup-0b | replugged into router R → target gets its IP from R | + wifi for **the same router R** |
| lan-setup-0c | replugged into router R → target gets its IP from R | + wifi for **a different router B** |
| lan-setup-0d | **removed** → target runs **wifi only** | wifi that reaches the internet |

---

## lan-setup-1 — laptop on R's wifi, target wired to R
*(needs R set up for netboot)*
```
+--------+ wifi  +----------+ ethernet +--------+
| laptop |------>| router R |--------->| target |
+--------+       +----------+          +--------+
```

## lan-setup-2 — laptop + target both on R's wifi
*(needs R set up for netboot)*
```
+--------+ wifi  +----------+  wifi  +--------+
| laptop |------>| router R |------->| target |
+--------+       +----------+        +--------+
```

---

## usb-0* — installer USB → target internal disk (manual boot), no laptop link
```
+-----+   +--------+
| USB |-->| target |   target: cabled into router R
+-----+   +--------+
```
All boot the same from USB. Variants differ only in connectivity:

| id | wired | wifi config |
|----|-------|-------------|
| usb-0a | LAN cable into R (internet via cable) | none |
| usb-0b | LAN cable into R (internet via cable) | + wifi for **the same router R** |
| usb-0c | LAN cable into R (internet via cable) | + wifi for **a different router B** |
