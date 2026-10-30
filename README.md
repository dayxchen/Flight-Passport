# Flight Passport

Flight Passport is a personal flight log for your phone. Type in a flight number and date, and the app finds the flight, saves it to your account, and builds up a picture of everywhere you've flown: a list of trips, a spinning 3D globe of your routes, a stats page, and photos attached to each flight.

It's a mobile-first web app. You can add it to your home screen and it opens full screen like a native app.

## Features

- **Add a flight.** Enter a flight number (like `UA123`) and pick a date. The app looks up the airline, airports, scheduled and actual times, status, and aircraft. If the lookup can't find it, you can fill in the details by hand.
- **My Flights.** All your saved flights, newest first. Flights that belong together, like connections, round trips and multi-city itineraries, are grouped into a single trip card.
- **Photos.** Attach up to 20 photos to each flight. They're shrunk on your device before upload, so big phone photos don't eat your data.
- **Globe.** An interactive 3D globe with an arc for every route. Tap an arc or airport for details. When you leave it alone, it spins and now and then flies the camera along one of your routes.
- **Stats.** Total flights, miles flown, time in the air, countries and airports visited, flights this year, plus highlights like your longest flight and most-flown airline.
- **Sign in** with Google or an emailed magic link. Your flights and photos are private to your account.
- **Dark mode**, which follows your system setting or can be toggled by hand.

## How it works

Flight Passport is a static site. It's plain HTML, CSS and JavaScript modules, with no build step or framework. Everything runs in the browser and talks directly to a few outside services:

| Service | Used for |
| --- | --- |
| [Supabase](https://supabase.com) | Sign-in (Google OAuth and magic links), the `flights` database table, and the `flight-photos` storage bucket |
| [AviationStack](https://aviationstack.com) | Looking up a flight by number and date |
| [adsbdb](https://www.adsbdb.com) | Filling in the aircraft registration and type when AviationStack leaves them out |
| [globe.gl](https://globe.gl) | Drawing the 3D globe (loaded from a CDN when you open the Globe tab) |

### Looking up a flight

1. The flight number is split into an airline code and a number, so `UA123`, `UAL123` and `ua 123` all work.
2. The app asks AviationStack for matching flights. For past dates it asks for that exact day. If the API plan doesn't allow historical lookups, the app remembers that and stops asking.
3. It picks the result whose flight number matches, checking the chosen date first and then one day either side to allow for time zones.
4. Airport codes are turned into full names using the bundled airport list, and the aircraft details are filled in from adsbdb if needed.
5. If nothing matches, the app shows a manual-entry form instead. The free AviationStack plan only covers about the last two days, so older flights usually go this way.

### Grouping flights into trips

A flight joins the current trip if it departs from an airport the trip has already visited and leaves within 21 days of the previous flight. A trip ends once you land back where it started. This handles connections, round trips and multi-city itineraries, while keeping separate visits to the same airport months apart as separate trips. See [js/trips.js](js/trips.js).

### Stats

Distances are great-circle miles between airport coordinates. Flight time uses actual departure and arrival times when they're known, falling back to scheduled times. Countries come from a bundled airport-to-country lookup.

### Photos

Photos are resized in the browser to at most 1600px on the long edge and saved as JPEG. They're uploaded to Supabase Storage at `<user id>/<flight id>/...` and shown through short-lived signed links, so they're never public. Deleting a flight deletes its photos too.

## Project layout

```
index.html              The whole app shell: login screen, tabs, and the four views
manifest.webmanifest    Lets the app be installed to a home screen
css/app.css             All styles, including dark mode
icons/icon.svg          App icon

js/
  app.js                Entry point: tabs, add-flight form, date picker, flight list
  config.js             AviationStack API key and URL
  supabase.js           Supabase client setup (project URL and public key)
  auth.js               Sign-in, sign-out, and session tracking
  api.js                Flight lookup, matching, and manual-entry flights
  db.js                 Reading and writing the flights table
  airports.js           Loads the bundled airport, coordinate and country data
  trips.js              Groups flights into trips
  globe.js              3D globe and the automatic camera tour
  stats.js              Stats page calculations and rendering
  photos.js             Photo storage (list, upload, delete, signed links)
  photo-ui.js           Photo strip, upload button, and full-screen viewer
  image.js              In-browser image resizing
  theme.js              Dark mode toggle
  util.js               Small shared helpers

data/
  airports.json             Airport names and cities by IATA/ICAO code
  airport-coords.json       Airport latitude/longitude (generated)
  airport-country.json      Airport country codes (generated)
  countries-110m.geojson    Country outlines for the globe (generated)

scripts/                Scripts that regenerate the files in data/
tests/                  Playwright tests
```

## Running it locally

There's nothing to build. Serve the folder with any static file server and open it in a browser:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Opening `index.html` straight from disk won't work, because the app loads its data files with `fetch` and uses JavaScript modules.

For sign-in to work, the address you serve from (for example `http://localhost:8000`) must be added to the allowed redirect URLs in the Supabase dashboard under **Authentication → URL Configuration**.

## Setting up your own backend

The repo points at an existing Supabase project and AviationStack key. To run your own copy:

1. **Supabase.** Create a project and put its URL and publishable (anon) key in [js/supabase.js](js/supabase.js).
   - Create a `flights` table with the columns listed in [js/db.js](js/db.js) (`flight_date`, `airline_name`, `flight_number`, `departure_iata`, and so on). `id` and `saved_at` should be filled in by the database, and each row should belong to the signed-in user.
   - Turn on row-level security so each user can only read, add and delete their own flights.
   - Create a private storage bucket called `flight-photos`, with policies that only let a user access files under their own user ID folder.
   - Under **Authentication → Providers**, turn on Google and email sign-in.
2. **AviationStack.** Sign up for an API key and put it in [js/config.js](js/config.js).

## Regenerating the data files

The coordinate, country and map files in `data/` are generated from public datasets ([OurAirports](https://ourairports.com/data/) and [Natural Earth](https://www.naturalearthdata.com/)). To rebuild them:

```sh
npm install
npm run build:coords      # data/airport-coords.json and data/airport-country.json
npm run build:countries   # data/countries-110m.geojson
```

## Tests

Tests use [Playwright](https://playwright.dev):

```sh
npm install
npx playwright install
npx playwright test
```

The `tests/` folder only holds Playwright's starter example so far.
