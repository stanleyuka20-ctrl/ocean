"""stations.py -- the measurement stations, defined ONCE.

taa_test.py, selftest.py and sweep.py each used to carry their own copy of this
list, in three different tuple orders.  They agreed by luck; the last time a
duplicated definition drifted, sweep.py optimised a different renderer from the
one that judged it and nominated a configuration at water +19% / detail 88% that
the acceptance test then measured at +7% / 81%.

REPS is part of the station, not of the caller.

The stations are not equally noisy, and pretending otherwise breaks the storm
station in particular.  Its shimmer is dominated by the spray population, which
is genuinely stochastic -- at a settled steady state it measures ~2650 particles
with a scatter of ~380, about 14% -- so single readings there spread ~25% no
matter how long the scene is left to settle.  A median of three still spreads
~17%, which is larger than the 8% effect the acceptance test is trying to
resolve: that verdict would be decided by noise.  More samples is the only
honest answer, and it is a property of the station, so it lives here.

Sampling error falls as 1/sqrt(n), so 9 readings take the storm spread from
~25% to ~8%.  The quiet stations do not need it and would only cost runtime.
"""
from collections import namedtuple

Station = namedtuple("Station", "label preset view reps")

#: preset is the weather preset to apply; view is (x, y, z, pitchDeg, yawDeg)
STATIONS = [
    Station("water level", "clearAtlantic", (0, 1.7, 0, 2, 30), 3),
    # aerial has a tiny baseline (~0.13 against ~2.5 at water level), so a
    # percentage there is a ratio of two small numbers: it belongs in the
    # reproducibility check more than anywhere else
    Station("aerial", "clearAtlantic", (0, 220, 0, 46, 30), 3),
    Station("storm spray", "storm", (0, 3.0, 0, 4, 30), 9),
    Station("underwater", "clearAtlantic", (0, -4.0, 0, -28, 30), 3),
]

#: the ghost/persistence station -- a single viewpoint, not part of the sweep
GHOST_STATION = Station("ghost", "clearAtlantic", (0, 2.0, 0, 3, 30), 3)
