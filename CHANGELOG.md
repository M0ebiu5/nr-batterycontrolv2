# Changelog

## 2026-04-24

### Fixed
- Preemptive discharge: glut day is now the current-or-next daylight period
  (was: required a night→day transition, which silently disabled preemptive
  for cron runs made after sunrise on the glut day itself). Regression:
  scenario 8.
- Preemptive eligibility window is now `now → post-glut sunrise` and sorted
  by price DESC, so the morning price peak is picked instead of the sub-1ct
  pre-dawn slots that the old "night + early-morning-before-PV>=load" window
  produced. Regression: scenario 7.
- Preemptive drain sizing now projects SOC with PV+load (plus any curtailed
  overflow above 100%) across the window, instead of assuming load-only.
  Daylight slots inside the window were previously under-counted.

### Changed
- Feed-in budget projection continues PAST `horizonIdx` through the first
  post-horizon daylight period, capturing PV curtailment that happens after
  the refill slot. Fixes zero-budget cases where the battery ends the night
  at 100% and tomorrow's PV will clearly curtail.

### Tests
- Added scenario 7: preemptive picks morning peak, skips low-price night.
- Added scenario 8: preemptive runs post-sunrise without tomorrow's prices.
