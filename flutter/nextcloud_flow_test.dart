// Automated L3 flow (dashboard-owned) — OPEN NEXTCLOUD.
// Injected by dash.run_l3_flutter(flow='nextcloud'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → connect and reach Providers → Services → wait for real tiles →
//       tap the Nextcloud tile → land on the service DETAIL page (ServicePage) and assert its
//       status card + hero title are present.
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
import 'package:selfprivacy/ui/pages/services/service.dart';
import 'package:selfprivacy/ui/molecules/cards/service_status.dart';

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

  testWidgets('Open the Nextcloud service detail (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle
      await shot(tester, 'launch');

      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'providers');
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — it likely could not connect within 180s.');

      expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
      await tester.tap(find.text('Services').first);
      expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
          reason: 'Services screen did not appear');

      // Wait for the real Nextcloud tile to load (not a skeleton).
      final ncTile = find.text('Nextcloud');
      final loaded = await pumpUntil(tester, ncTile, timeout: const Duration(seconds: 90));
      await shot(tester, 'services');
      expect(loaded, isTrue,
          reason: 'Nextcloud tile never appeared — the Services list did not load real data within 90s.');

      // Tap the Nextcloud tile → service detail page.
      await tester.ensureVisible(ncTile.first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(ncTile.first);
      expect(await pumpUntil(tester, find.byType(ServicePage), timeout: const Duration(seconds: 30)),
          isTrue,
          reason: 'Nextcloud service detail page (ServicePage) did not open after tapping the tile');

      // Assert we're really on the Nextcloud detail: hero title + a status card.
      final onDetail = await pumpUntil(tester, find.byType(ServiceStatusCard),
          timeout: const Duration(seconds: 30));
      await shot(tester, 'nextcloud-detail');
      expect(onDetail, isTrue,
          reason: 'ServiceStatusCard did not render on the Nextcloud detail page');
      expect(find.text('Nextcloud'), findsWidgets,
          reason: 'Nextcloud hero title missing on the detail page');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
