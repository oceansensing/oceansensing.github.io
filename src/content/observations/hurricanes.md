---
title: Hurricanes
short: >-
  Uncrewed platforms measure the ocean beneath tropical cyclones, where ships
  cannot go. This map shows active storms and the assets now reporting.
summary: >-
  Live positions of underwater gliders worldwide, NOAA uncrewed surface
  vehicles and Argo floats, over modelled currents, sea-surface temperature
  and salinity, with active National Hurricane Center tracks and cones.
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

Everything on the map is a public feed, refetched hourly and shown only where
a platform has reported recently. The gridded fields carry the model run they
came from, so the map says how fresh it is rather than leaving you to assume.
Colour scales are yours to set: pick a colormap, pin the range, or leave it to
follow whatever water is on screen.

**Platforms**

- [NOAA National Hurricane Center](https://www.nhc.noaa.gov/) — active storm positions, forecast tracks and cones, and the observed best track over the past five days
- [US IOOS Glider Data Assembly Center](https://gliders.ioos.us/erddap) — glider positions, United States
- [NOC / BODC](https://linkedsystems.uk/erddap) — glider positions, United Kingdom
- [Ocean Tracking Network](https://erddap.oceantrack.org/erddap) — glider positions, Canada
- [Voice of the Ocean](https://erddap.observations.voiceoftheocean.org/erddap) — glider positions, Sweden
- [NOAA PMEL](https://data.pmel.noaa.gov/pmel/erddap) — uncrewed surface vehicle positions
- [Ifremer Argo GDAC](https://erddap.ifremer.fr/erddap) — Argo float positions and last profile time. The window here is twelve days rather than five: a float surfaces once per ten-day cycle, so a shorter one hides most of the array mid-dive

**Ocean fields**

- [US Navy ESPC-D-V02](https://tds.hycom.org/thredds/) — a 1/12° global forecast, via HYCOM's OPeNDAP: currents at the surface and at 60 m, sea-surface temperature, and sea-surface salinity. One model, so the flow, the heat and the salt on screen are the same ocean at the same hour
- [NOAA NCEI OISST v2.1](https://www.ncei.noaa.gov/products/optimum-interpolation-sst) — sea-surface temperature as *observed* rather than forecast: satellite and in-situ measurements blended onto a 1/4° grid. The preliminary product, a few days behind, rather than the final one a fortnight back
- [NOAA NCEI DEM global mosaic](https://www.ncei.noaa.gov/maps/bathymetry/) — seafloor depth, queried a point at a time when you click

**Basemaps**

- [GEBCO](https://www.gebco.net/) — global bathymetry, the default
- [Esri Ocean](https://www.esri.com/) — alternative bathymetry
- [OpenStreetMap](https://www.openstreetmap.org/copyright) — alternative reference map
- [Natural Earth](https://www.naturalearthdata.com/) — coastline and boundaries, bundled with the site so one basemap option needs no third-party requests

The glider endpoints follow the [OceanGliders regional data
endpoints](https://www.europeanglidercommunity.org/data-management-and-tools/)
list. Coriolis publishes through a selection portal rather than a machine
endpoint, and Australia's IMOS glider data routes through the AODN portal, so
neither is included yet.
