// Automated L3 flow (dashboard-owned). `dash here --long` injects this into the app's
// integration_test/ dir at run time, runs it, then restores the Manager repo byte-for-byte —
// so the automation is real but the Manager repo is never left modified.
//
// Flow: launch the real app → wait for it to connect over Tor and reach Providers →
//       tap Services → back to Providers. Driven headlessly (no clicking); screen-recorded,
//       and a PNG of the real UI is captured at each step.
//
// NOTES (hard-won — see the dashboard handover):
// - Never use pumpAndSettle() — the app animates continuously while connecting over Tor, so it
//   never settles and times out at 10 min. Poll with bounded pump() instead.
// - The app's main() replaces ErrorWidget.builder; the test framework asserts it's unchanged at
//   teardown, so we capture the default first and restore it.
// - VIDEO: IntegrationTestWidgetsFlutterBinding is a *live* binding, but its default frame policy
//   (fadePointers) does not present the app's self-scheduled frames to the display, so an Xvfb
//   screen-capture is mostly black. Setting framePolicy = fullyLive makes every frame the app
//   schedules actually paint to the display → the recording shows the real UI.
// - SCREENSHOTS: binding.takeScreenshot() is NOT supported on Linux desktop (integration_test has
//   no Linux plugin — the captureScreenshot method channel has no handler and throws
//   MissingPluginException). Instead we grab the test's own X display (the Xvfb the dashboard
//   records) with ffmpeg. The test process runs on the host, so it can read $DISPLAY directly.

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/services/services.dart';

/// Pump in bounded steps until [finder] matches, or [timeout] elapses. Returns whether it appeared.
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
  // Frame-policy tradeoff (hard-won): fullyLive presents EVERY frame the app schedules → a smooth
  // recording, but on this headless software-GL display it pegs the CPU and STARVES the app's async
  // socket I/O to Tor. The app then can't connect (getApiVersion → hostUnreachable) and
  // integration_test dies on the first uncaught async error before the app's own 10s retry loop can
  // recover. Default (pump-driven live) frames keep the Tor connection healthy: the recording is
  // choppier (frames land only on pump) but never black, and the per-step ffmpeg screenshots are
  // always crisp. Opt into the smooth-but-fragile mode with FRAME_POLICY_LIVE=1.
  if (Platform.environment['FRAME_POLICY_LIVE'] == '1') {
    binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  }

  final ErrorWidgetBuilder defaultErrorBuilder = ErrorWidget.builder;

  final String? shotDir = Platform.environment['SHOT_DIR'];
  final String display = Platform.environment['DISPLAY'] ?? ':99';
  final String shotSize = Platform.environment['SHOT_SIZE'] ?? '1280x800';
  int shotSeq = 0;

  /// Capture a PNG of the current UI from the X display into SHOT_DIR (if the dashboard set it).
  /// Pumps a few frames first so the current screen is actually painted, then grabs one frame.
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

  testWidgets('Providers -> Services -> Providers (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle (animates while connecting)
      await shot(tester, 'launch'); // splash / connecting screen

      // Cold Tor start + first GraphQL round-trip can take a while; wait generously.
      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'providers');
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — it likely could not connect to the '
              'backend over Tor within 180s.');

      // Providers -> Services
      expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
      await tester.tap(find.text('Services').first);
      expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
          reason: 'Services screen did not appear after tapping the Services tab');

      // Wait for REAL service data — not just the page. The Services page renders 7 skeleton
      // placeholder cards while loading, so reaching the page proves nothing; we must see an
      // actual service load. The AllServices query shells out to `nix` on the backend and runs
      // over Tor, so it can take ~30s (query ~14s + the app's 10s poll cycle). If it never
      // appears, the backend query is failing (e.g. `nix` missing from the API service PATH) —
      // and this test SHOULD go red rather than falsely pass on an empty, still-loading screen.
      final servicesLoaded = await pumpUntil(
          tester,
          find.textContaining(RegExp(r'Nextcloud|Matrix|Jitsi|Prometheus|Forgejo|Mail Server')),
          timeout: const Duration(seconds: 90));
      await shot(tester, 'services');
      expect(servicesLoaded, isTrue,
          reason: 'Services list never populated with real data over Tor within 90s. The backend '
              'AllServices query likely failed — check that `nix` is on the selfprivacy-api '
              'service PATH in the VM (systemctl show selfprivacy-api -p Environment).');

      // Services -> back to Providers
      await tester.tap(find.text('Providers').first);
      expect(await pumpUntil(tester, find.byType(ProvidersPage)), isTrue,
          reason: 'Did not return to the Providers screen');
      await shot(tester, 'back-to-providers');
    } finally {
      // The app replaced ErrorWidget.builder; restore it before the framework's post-test invariant
      // check (which runs before tearDown), so it doesn't mask the real result.
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
