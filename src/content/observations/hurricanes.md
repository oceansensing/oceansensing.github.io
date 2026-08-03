---
title: Hurricanes
short: >-
  Uncrewed platforms measure the ocean beneath tropical cyclones, where ships
  cannot go. This map shows active storms and the assets now reporting.
summary: >-
  Live positions of underwater gliders worldwide, NOAA uncrewed surface
  vehicles and Argo floats, over modelled currents, sea-surface temperature
  and salinity, with seafloor contours and active National Hurricane Center
  tracks and cones.
cover:
  src: ./hurricane-florence-iss.jpg
  alt: >-
    Hurricane Florence seen obliquely from orbit, its eye open at the centre of
    a broad spiral, with the curve of the Earth's horizon behind it and a solar
    array of the International Space Station in the foreground.
  credit: Hurricane Florence, 12 September 2018 — NASA / ISS Expedition 56
map: assets
order: 2
---

A hurricane's intensity depends on the ocean beneath it — on how much warm
water the storm can draw from before its own mixing brings cooler water to the
surface. That subsurface structure is what forecast models most need and least
often have, and it is measured in the one place ships cannot safely work.
Uncrewed platforms fill the gap: gliders profile temperature and salinity
through the upper ocean and surface to report, while uncrewed surface vehicles
ride out the storm at the air–sea interface, measuring winds, waves and fluxes.
C4PO has flown gliders for hurricane monitoring in the Mid-Atlantic through
MARACOOS and NOAA-supported deployments, and works on the next generation of
uncrewed surface vehicles and their launch and recovery systems.

## Data sources

Public feeds, refetched hourly and shown only where a platform has reported
recently. The depth contours are the exception: computed once, since the
seafloor does not change. Gridded fields carry the model run they came from.
Colour scale, range and contour opacity are yours to set.

**Platforms**

- [NOAA National Hurricane Center](https://www.nhc.noaa.gov/) — storm positions, forecast tracks and cones, and the observed track over the past five days
- [US IOOS Glider DAC](https://gliders.ioos.us/erddap) — glider positions, United States
- [NOC / BODC](https://linkedsystems.uk/erddap) — glider positions, United Kingdom
- [Ocean Tracking Network](https://erddap.oceantrack.org/erddap) — glider positions, Canada
- [Voice of the Ocean](https://erddap.observations.voiceoftheocean.org/erddap) — glider positions, Sweden
- [NOAA PMEL](https://data.pmel.noaa.gov/pmel/erddap) — uncrewed surface vehicle positions
- [Ifremer Argo GDAC](https://erddap.ifremer.fr/erddap) — Argo float positions and last profile time, over a twelve-day window

**Ocean fields**

- [US Navy ESPC-D-V02](https://tds.hycom.org/thredds/) — 1/12° global forecast, via HYCOM's OPeNDAP: currents at the surface and at 60 m, sea-surface temperature, and salinity
- [NOAA NCEI OISST v2.1](https://www.ncei.noaa.gov/products/optimum-interpolation-sst) — observed sea-surface temperature, 1/4° daily, preliminary product

**Seafloor and shoreline**

- [GEBCO](https://www.gebco.net/) 2026 — depth contours from 20 m to 10,000 m, from the 15 arc-second grid
- [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) — shoreline
- [NOAA NCEI DEM global mosaic](https://www.ncei.noaa.gov/maps/bathymetry/) — seafloor depth at a point, on click

**Boundaries**

- [Marine Regions](https://www.marineregions.org/) (VLIZ) — Exclusive Economic Zone boundaries, and which country's zone a point falls in

**Basemaps**

- [GEBCO](https://www.gebco.net/) — global bathymetry, the default
- [Esri Ocean](https://www.esri.com/) — alternative bathymetry
- [OpenStreetMap](https://www.openstreetmap.org/copyright) — alternative reference map
- [Natural Earth](https://www.naturalearthdata.com/) — country and state borders

Glider endpoints follow the [OceanGliders regional
list](https://www.europeanglidercommunity.org/data-management-and-tools/).
Coriolis is not included — its glider archive is delayed mode, weeks behind —
nor is Australia's IMOS, which has no open endpoint.
