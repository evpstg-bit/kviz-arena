# Mobile layout fit

- Added mobile-specific containment rules to prevent horizontal page overflow and reduce the need to pinch-zoom/"pull back" the page.
- Made app layout, navigation, forms, tables, dialogs, cards, and media respect the device viewport width.
- Adjusted narrow-screen header and language/theme controls to wrap and fit within the screen.
- Added a cache-busting query to `ui.css` so deployed browsers fetch the new mobile styles.
- No quiz, game, report, folder, or settings logic was changed.

Validation performed: viewport meta tag confirmed; CSS and HTML edits inspected; ZIP integrity checked. A full real-device/browser visual test was not available in this environment.
