// Automated L3 flow (dashboard-owned). `dash here --long` injects this into the app's
// integration_test/ dir at run time, runs it, then restores the Manager repo byte-for-byte —
// so the automation is real but the Manager repo is never left modified.
//
// Flow: launch the real app → wait for it to connect over Tor and reach Providers →
//       tap Services → back to Providers. Driven headlessly (no clicking); screen-recorded.
//
// NOTE: never use pumpAndSettle() here — the app animates continuously while connecting over Tor,
// so pumpAndSettle never settles and times out at 10 min. Poll with bounded pump() instead.

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
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Providers -> Services -> Providers (automated)', (tester) async {
    app.main();
    await tester.pump(const Duration(seconds: 3)); // boot; do NOT settle (app animates while connecting)

    // Cold Tor start + first GraphQL round-trip can take a while; wait generously.
    final onProviders = await pumpUntil(tester, find.byType(ProvidersPage),
        timeout: const Duration(seconds: 180));
    expect(onProviders, isTrue,
        reason: 'App never reached the Providers screen — it likely could not connect to the '
            'backend over Tor within 180s (check host tor on 9050 and the .onion is reachable).');

    // Providers -> Services
    expect(find.text('Services'), findsWidgets, reason: 'no Services tab in the nav bar');
    await tester.tap(find.text('Services').first);
    expect(await pumpUntil(tester, find.byType(ServicesPage)), isTrue,
        reason: 'Services screen did not appear after tapping the Services tab');

    // Services -> back to Providers
    await tester.tap(find.text('Providers').first);
    expect(await pumpUntil(tester, find.byType(ProvidersPage)), isTrue,
        reason: 'Did not return to the Providers screen');
  });
}
