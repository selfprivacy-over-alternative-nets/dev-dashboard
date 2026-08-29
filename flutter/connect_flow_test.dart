// Automated L3 flow (dashboard-owned) — CONNECT TO SERVER.
// Injected by dash.run_l3_flutter(flow='connect'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → the app auto-configures the server+token from the --dart-defines → it connects
//       over the selected transport and reaches Providers, then loads REAL backend data. Real data
//       loading is the honest end-to-end proof of connect (a bare navigation-only green is a lie).
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

  testWidgets('Connect to server over the transport (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle (animates while connecting)
      await shot(tester, 'launch');

      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'providers');
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — it could not connect to the backend '
              'over the transport within 180s.');

      // Honest proof of connect: real backend data appears (not just the empty/default UI). The
      // Providers page shows only Server/Domain/Backups cards (which render with defaults even
      // offline — NOT proof of a connection), so we go to the Services tab and wait for a REAL
      // service tile to load from the backend over the transport.
      expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
      await tester.tap(find.text('Services').first);
      expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
          reason: 'Services screen did not appear after tapping the Services tab');
      final dataLoaded = await pumpUntil(
          tester,
          find.textContaining(RegExp(r'Nextcloud|Matrix|Jitsi|Prometheus|Forgejo|Mail Server')),
          timeout: const Duration(seconds: 90));
      await shot(tester, 'connected');
      expect(dataLoaded, isTrue,
          reason: 'App reached the UI but never loaded real backend data within 90s — the '
              'connection to the API over the transport is not actually working.');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
