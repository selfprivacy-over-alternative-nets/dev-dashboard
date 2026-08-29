// Automated L3 flow (dashboard-owned) — NAVIGATE MENUS.
// Injected by dash.run_l3_flutter(flow='menus'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → connect and reach Providers (with REAL data) → walk the main tabs
//       Services → Users → More → back to Providers, asserting each page widget appears.
//
// See providers_flow_test.dart for the hard-won notes (no pumpAndSettle; default frame policy;
// restore ErrorWidget.builder; ffmpeg x11grab screenshots).

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/services/services.dart';
import 'package:selfprivacy/ui/pages/users/users.dart';
import 'package:selfprivacy/ui/pages/more/more.dart';

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

  Future<void> tapNav(WidgetTester tester, String label) async {
    expect(find.text(label), findsWidgets, reason: 'no $label tab in the nav bar');
    await tester.tap(find.text(label).first);
  }

  testWidgets('Navigate the main menus (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle
      await shot(tester, 'launch');

      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'providers');
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — it likely could not connect within 180s.');

      // Providers -> Services
      await tapNav(tester, 'Services');
      expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
          reason: 'Services screen did not appear');
      // Prove the connection is real (not a nav-only green): a real service tile must load on the
      // Services page (the Providers page shows no service data).
      final dataLoaded = await pumpUntil(
          tester,
          find.textContaining(RegExp(r'Nextcloud|Matrix|Jitsi|Prometheus|Forgejo|Mail Server')),
          timeout: const Duration(seconds: 90));
      expect(dataLoaded, isTrue,
          reason: 'Services never populated with real data within 90s.');
      await shot(tester, 'services');

      // Services -> Users
      await tapNav(tester, 'Users');
      expect(await pumpUntil(tester, find.byType(UsersPage)), isTrue,
          reason: 'Users screen did not appear');
      await shot(tester, 'users');

      // Users -> More
      await tapNav(tester, 'More');
      expect(await pumpUntil(tester, find.byType(MorePage)), isTrue,
          reason: 'More screen did not appear');
      await shot(tester, 'more');

      // More -> back to Providers
      await tapNav(tester, 'Providers');
      expect(await pumpUntil(tester, find.byType(ProvidersPage)), isTrue,
          reason: 'Did not return to the Providers screen');
      await shot(tester, 'back-to-providers');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
