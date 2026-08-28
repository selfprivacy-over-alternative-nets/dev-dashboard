// Automated L3 flow (dashboard-owned). `dash here --long` injects this into the app's
// integration_test/ dir at run time, runs it, then restores the Manager repo byte-for-byte —
// so the automation is real but the Manager repo is never left modified.
//
// Flow: launch the real app → verify Providers (default) → tap Services → back to Providers → done.
// Driven headlessly (no clicking); run under a screen recorder to capture the UI.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:selfprivacy/main.dart' as app;
import 'package:selfprivacy/ui/pages/providers/providers.dart';
import 'package:selfprivacy/ui/pages/services/services.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Providers -> Services -> Providers (automated)', (tester) async {
    app.main();
    await tester.pumpAndSettle(const Duration(seconds: 6));

    // If the backend connection isn't up, the app sits on the connect/setup screen.
    // The launch is still recorded; nav assertions require a connected backend.
    if (find.text('Providers').evaluate().isEmpty) {
      // ignore: avoid_print
      print('[flow] no Providers tab — app on setup screen (backend not reachable). Launch recorded.');
      return;
    }

    expect(find.byType(ProvidersPage), findsOneWidget);
    await Future<void>.delayed(const Duration(milliseconds: 700));

    await tester.tap(find.text('Services'));
    await tester.pumpAndSettle();
    expect(find.byType(ServicesPage), findsOneWidget);
    await Future<void>.delayed(const Duration(milliseconds: 700));

    await tester.tap(find.text('Providers'));
    await tester.pumpAndSettle();
    expect(find.byType(ProvidersPage), findsOneWidget);
    await Future<void>.delayed(const Duration(milliseconds: 700));
  });
}
