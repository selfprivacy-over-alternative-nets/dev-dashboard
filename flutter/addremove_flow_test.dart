// Automated L3 flow (dashboard-owned) — ADD / REMOVE SERVICE.  ⚠️ MUTATES THE SHARED BACKEND.
// Injected by dash.run_l3_flutter(flow='addremove'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → connect → Services → open a NON-REQUIRED, currently-active service (Jitsi Meet) →
//       DISABLE it → APPLY the queued job via the Jobs panel → confirm the BACKEND APPLIED the
//       mutation (the toggle job reports "Service disabled." over the transport). dash re-enables the
//       service afterwards so the shared backend is left clean.
//
// KEY app behaviour (hard-won): tapping "Disable service" only QUEUES a ClientJob (JobsCubit.addJob).
// Nothing happens until it is APPLIED via the Jobs panel: tap the jobs FAB (BrandFab, in the desktop
// NavigationDrawer) → "Start" (JobsCubit.applyAll) → the app runs the enable/disable MUTATION, then
// triggers a nixos rebuild, then shows a "Done" button when finished.
//
// WHAT WE ASSERT + WHY (hard-won): the mutation succeeding — the job card showing "Service disabled."
// — is the honest end-to-end proof that the app drove the add/remove over the transport and the
// backend accepted it. We deliberately do NOT assert the service's runtime STATUS flips to
// Stopped/Disabled: that requires the `sp-nixos-rebuild.service` systemd unit, which the minimal
// test backend (Manager/backend/nixos/selfprivacy-tor-core.nix) does not define — so `apply()`
// errors "Unit sp-nixos-rebuild.service not found" and the unit never actually stops. That is a
// backend-infra gap of the test VM (same class as the earlier missing-`nix`-on-PATH gap), not an app
// or transport problem, and NOT triggering a real rebuild keeps the shared backend stable for the
// other flows. The disable leaves the service isEnabled=false in userdata; dash re-enables it after.
//
// See providers_flow_test.dart for the other hard-won notes (no pumpAndSettle; default frame policy;
// restore ErrorWidget.builder; ffmpeg x11grab screenshots).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/services/services.dart';
import 'package:selfprivacy/ui/pages/services/service.dart';
import 'package:selfprivacy/ui/molecules/cards/service_status.dart';
import 'package:selfprivacy/ui/molecules/buttons/flash_fab.dart';
import 'package:selfprivacy/ui/organisms/jobs/jobs_content.dart';

// The non-required service we toggle. Jitsi Meet is stateless-ish and safe to disable.
const String kServiceName = 'Jitsi';

Future<bool> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 30),
  Duration step = const Duration(milliseconds: 400),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(step);
    if (finder.evaluate().isNotEmpty) return true;
  }
  return false;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  if (Platform.environment['FRAME_POLICY_LIVE'] == '1') {
    binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  }

  final ErrorWidgetBuilder defaultErrorBuilder = ErrorWidget.builder;

  final String? shotDir = Platform.environment['SHOT_DIR'];
  final String display = Platform.environment['DISPLAY'] ?? ':99';
  final String shotSize = Platform.environment['SHOT_SIZE'] ?? '1280x800';
  int shotSeq = 0;

  Future<void> shot(WidgetTester tester, String name) async {
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    if (shotDir == null) return;
    final label = '${(++shotSeq).toString().padLeft(2, '0')}-$name';
    final path = '$shotDir/$label.png';
    try {
      final r = await Process.run('ffmpeg', <String>[
        '-y', '-f', 'x11grab', '-video_size', shotSize, '-i', display,
        '-frames:v', '1', path,
      ]);
      // ignore: avoid_print
      print(r.exitCode == 0
          ? '[shot] $label -> $path'
          : '[shot] $label FAILED (ffmpeg ${r.exitCode}): ${r.stderr}');
    } catch (e) {
      // ignore: avoid_print
      print('[shot] $label errored: $e');
    }
  }

  // Open the target service's detail page from the Services tab.
  Future<void> openService(WidgetTester tester) async {
    expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
    await tester.tap(find.text('Services').first);
    expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
        reason: 'Services screen did not appear');
    final tile = find.textContaining(kServiceName);
    expect(await pumpUntil(tester, tile, timeout: const Duration(seconds: 90)), isTrue,
        reason: '$kServiceName tile never loaded — Services list did not populate over the transport.');
    await tester.ensureVisible(tile.first);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(tile.first);
    expect(await pumpUntil(tester, find.byType(ServicePage), timeout: const Duration(seconds: 30)),
        isTrue,
        reason: '$kServiceName detail page did not open');
    expect(await pumpUntil(tester, find.byType(ServiceStatusCard), timeout: const Duration(seconds: 30)),
        isTrue,
        reason: 'ServiceStatusCard did not render on the $kServiceName detail page');
  }

  testWidgets('Disable a service; backend applies the mutation (automated, MUTATES backend)',
      timeout: const Timeout(Duration(minutes: 15)), (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle
      await shot(tester, 'launch');

      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — could not connect within 180s.');
      await shot(tester, 'providers');

      // Open the service; it should start ACTIVE ("Up and running").
      await openService(tester);
      await shot(tester, 'service-before');
      expect(find.text('Up and running'), findsWidgets,
          reason: '$kServiceName was not initially active — test needs a known-active service to toggle.');

      // --- DISABLE + APPLY ---
      final disableTile = find.text('Disable service');
      expect(disableTile, findsWidgets, reason: 'no "Disable service" action — is the service required?');
      await tester.ensureVisible(disableTile.first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(disableTile.first); // queues a ServiceToggleJob (turn off)
      await shot(tester, 'disable-queued');

      // Open the jobs panel via the BrandFab and apply.
      final fab = find.byType(BrandFab);
      expect(await pumpUntil(tester, fab, timeout: const Duration(seconds: 20)), isTrue,
          reason: 'jobs FAB (BrandFab) not found — cannot apply the queued job');
      await tester.tap(fab.first);
      final start = find.text('Start');
      expect(await pumpUntil(tester, start, timeout: const Duration(seconds: 30)), isTrue,
          reason: 'jobs modal did not show the Start button');
      await tester.ensureVisible(start.first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(start.first); // applyAll → runs the disableService mutation

      // Wait for the applied job to report success FROM THE BACKEND over the transport.
      // "Service disabled." is the disableService mutation's return message.
      final applied = await pumpUntil(
          tester, find.textContaining('Service disabled'),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'disable-applied');
      expect(applied, isTrue,
          reason: 'The backend never confirmed the disable mutation ("Service disabled.") within '
              '180s — the app could not apply the service toggle over the transport.');

      // The apply also finishes (a "Done" button appears even though the backend rebuild unit is
      // absent on the minimal test VM). Acknowledge + dismiss so we leave cleanly.
      final done = find.text('Done');
      if (await pumpUntil(tester, done, timeout: const Duration(seconds: 60))) {
        await tester.tap(done.last); // acknowledgeFinished
        await tester.pump(const Duration(milliseconds: 500));
      }
      for (var i = 0; i < 3; i++) {
        if (find.byType(JobsContent).evaluate().isEmpty) break;
        await tester.tapAt(const Offset(640, 8)); // dismiss the modal barrier
        await tester.pump(const Duration(milliseconds: 500));
      }
      await shot(tester, 'done');
      // NOTE: the service's runtime status stays "Up and running" because no nixos rebuild runs on
      // this backend (see the header). dash re-enables the service afterwards to restore userdata.
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
