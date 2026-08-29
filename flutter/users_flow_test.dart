// Automated L3 flow (dashboard-owned) — USERS LIST LOADS.
// Injected by dash.run_l3_flutter(flow='users'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → connect and reach Providers → Users tab → wait for a REAL user to load from the
//       backend over the transport (the page shows 7 skeleton rows while loading, so reaching the
//       page proves nothing — we wait for the real 'admin' account).
//
// See providers_flow_test.dart for the hard-won notes (no pumpAndSettle; default frame policy;
// restore ErrorWidget.builder; ffmpeg x11grab screenshots).

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/users/users.dart';

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

  testWidgets('Users list loads real data (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle
      await shot(tester, 'launch');

      final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'providers');
      expect(onProviders, isTrue,
          reason: 'App never reached the Providers screen — it likely could not connect within 180s.');

      // Providers -> Users
      expect(find.text('Users'), findsWidgets, reason: 'no Users tab in the nav bar');
      await tester.tap(find.text('Users').first);
      expect(await pumpUntil(tester, find.byType(UsersPage)), isTrue,
          reason: 'Users screen did not appear after tapping the Users tab');

      // REAL data (not the 7 skeleton rows): the seeded 'admin' account must load over the transport.
      final usersLoaded = await pumpUntil(tester, find.text('admin'),
          timeout: const Duration(seconds: 90));
      await shot(tester, 'users');
      expect(usersLoaded, isTrue,
          reason: 'Users list never populated with the real "admin" account within 90s — the backend '
              'getUsers query likely failed over the transport.');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
