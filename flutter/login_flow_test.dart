// Automated L3 flow (dashboard-owned) — LOGIN / AUTH.
// Injected by dash.run_l3_flutter(flow='login'), then the Manager repo is restored byte-for-byte.
//
// Flow: launch → the app auto-authenticates with the API token from the --dart-define → it loads
//       the AUTHENTICATED session (RootPage, NOT the onboarding flow) and pulls REAL backend data.
//       We assert RootPage is present, OnboardingPage is absent, and real data loads — proving the
//       token was accepted end-to-end.
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
import 'package:selfprivacy/ui/pages/services/services.dart';
import 'package:selfprivacy/ui/pages/onboarding/onboarding.dart';

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

      // Honest proof the authenticated session actually talks to the API: real data loads. The
      // Providers page cards render with defaults even offline, so we go to the Services tab and
      // wait for a REAL service tile fetched with the token.
      expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
      await tester.tap(find.text('Services').first);
      expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
          reason: 'Services screen did not appear after tapping the Services tab');
      final dataLoaded = await pumpUntil(
          tester,
          find.textContaining(RegExp(r'Nextcloud|Matrix|Jitsi|Prometheus|Forgejo|Mail Server')),
          timeout: const Duration(seconds: 90));
      await shot(tester, 'session-data');
      expect(dataLoaded, isTrue,
          reason: 'Authenticated but never loaded real backend data within 90s.');
    } finally {
      ErrorWidget.builder = defaultErrorBuilder;
    }
  });
}
