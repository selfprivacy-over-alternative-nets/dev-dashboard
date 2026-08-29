// Automated L3 flow (dashboard-owned) — LOGIN / AUTH.
// Injected by dash.run_l3_flutter(flow='login'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → the app auto-authenticates with the API token → assert we're in the AUTHENTICATED
//       shell (RootPage, NOT onboarding) → open More → Devices and wait for the real API-token /
//       device list to load ("Initial device"). The Devices list is an AUTH-GATED endpoint (it lists
//       the server's API tokens), so loading it is honest proof the token was accepted — distinct
//       from `services`/`connect` (which read public-ish server/service data).
//
// See providers_flow_test.dart for the hard-won notes (no pumpAndSettle; default frame policy;
// restore ErrorWidget.builder; ffmpeg x11grab screenshots).

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/root_route.dart';
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/onboarding/onboarding.dart';
import 'package:selfprivacy/ui/pages/more/more.dart';
import 'package:selfprivacy/ui/pages/devices/devices.dart';

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

  testWidgets('Authenticated session loads (automated)', (tester) async {
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle
      await shot(tester, 'launch');

      // The authenticated home is RootPage (with the Providers tab). Onboarding must NOT show.
      final onRoot = await pumpUntil(tester, find.byType(ProvidersPage),
          timeout: const Duration(seconds: 180));
      await shot(tester, 'authenticated');
      expect(onRoot, isTrue,
          reason: 'App never reached the authenticated home (Providers) within 180s — the token '
              'was likely not accepted or the backend was unreachable.');
      expect(find.byType(RootPage), findsWidgets,
          reason: 'RootPage (authenticated shell) is not present');
      expect(find.byType(OnboardingPage), findsNothing,
          reason: 'App is stuck on the onboarding screen — it is NOT authenticated.');

      // Open More -> Devices: the API-token/device list is AUTH-GATED, so loading it proves the token.
      expect(find.text('More'), findsWidgets, reason: 'no More tab in the nav bar');
      await tester.tap(find.text('More').first);
      expect(await pumpUntil(tester, find.byType(MorePage)), isTrue,
          reason: 'More screen did not appear');
      expect(find.text('Devices'), findsWidgets, reason: 'no Devices entry on the More page');
      await tester.tap(find.text('Devices').first);
      expect(await pumpUntil(tester, find.byType(DevicesPage), timeout: const Duration(seconds: 30)),
          isTrue,
          reason: 'Devices page did not open');

      // The current token's device ("Initial device") must load from the auth-gated tokens endpoint.
      final devicesLoaded = await pumpUntil(tester, find.text('Initial device'),
          timeout: const Duration(seconds: 90));
      await shot(tester, 'devices');
      expect(devicesLoaded, isTrue,
          reason: 'The authenticated device list never loaded ("Initial device" absent) within 90s — '
              'the API token was not accepted over the transport.');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
