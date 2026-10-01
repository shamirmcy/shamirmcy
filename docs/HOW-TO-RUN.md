# Running KM DocH on your computer

No coding needed. You will end up with a test page in your browser where you can book a visit as a patient and handle it as a doctor or nurse.

## One-time setup (about 15 minutes)

1. **Install Docker Desktop.** It runs the server, database and everything else for you.
   - Windows or Mac: https://www.docker.com/products/docker-desktop/ → download → install → open it once and wait until it says it is running.
2. **Download KM DocH.**
   - Go to https://github.com/shamirmcy/shamirmcy → green **Code** button → **Download ZIP**.
   - Unzip it somewhere easy to find, such as your Desktop.

## Start it

- **Windows:** open the unzipped folder and double-click **`start-windows.bat`**.
- **Mac:** open the unzipped folder, right-click **`start-mac.command`** → **Open** → **Open**. macOS asks the first time because the file is from the internet.

The first start takes 5–10 minutes. Later starts take seconds. When it's ready, your browser opens **http://localhost:3000/dev** by itself.

To stop it, double-click **`stop-windows.bat`** or **`stop-mac.command`**.

## Try a full visit (5 minutes)

On the test page, the **Provider** side is on the right and the **Patient** side on the left.

1. **Provider:**
   1. Click **Send code**, then **Sign in**. In test mode the code is filled in for you.
   2. Click, in order: **Approve me**, **Accept practice terms**, **Allow location**, **Go on duty**.
2. **Patient:**
   1. Click **Send code**, then **Sign in**.
   2. Type `indira` in the address search and pick a result.
   3. Choose a service, click **See price**, then **Agree and book**.
3. **Provider:** the request appears under **Requests**. Click **Accept**.
4. **Patient:** you'll see the doctor's name, the arrival time in minutes, and a 4-digit **door code**.
5. **Provider:** type the door code, then click **Arrived**, **Start visit** and **Complete visit**.
6. **Patient:** the booking shows **Completed**. You can rate it and download the receipt.

Address search in test mode knows a few sample places: Indiranagar, HAL 2nd Stage, Domlur, Kumbakonam, and Koramangala (shown as "not served yet"). With a Google Maps key it searches all of India.

**API docs** (top right) lists every server function. It's useful for whoever builds the phone apps.

## Switching on real WhatsApp, SMS and Google Maps

In test mode nothing is really sent: codes appear on screen. To send real messages, create these accounts and give the keys to your developer (or to me). They go in a `.env` file. See `.env.example` for the exact names.

| What | Where to sign up | What to hand over |
|---|---|---|
| WhatsApp codes | Meta Business Manager → WhatsApp → Cloud API. Create an **authentication** message template named `kmdoch_otp` with a "copy code" button in English, Tamil, Kannada and Hindi | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`. In Meta's webhook settings, point the webhook at `https://<your-server>/v1/webhooks/whatsapp`, subscribe to message statuses, and choose any `WHATSAPP_VERIFY_TOKEN` |
| SMS codes (backup when WhatsApp fails, and for people without WhatsApp) | MSG91 (msg91.com). Register a DLT template for the OTP message (required in India) | `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID` |
| Google Maps (arrival times and address search) | Google Cloud Console → enable **Routes API**, **Places API (New)** and **Geocoding API** → create an API key restricted to those three APIs | `GOOGLE_MAPS_API_KEY`, and set `MAPS_PROVIDER=google` |

How sign-in codes are delivered:
- Codes go by **WhatsApp first**.
- If WhatsApp fails straight away, the same request sends the code by **SMS** instead.
- If WhatsApp accepts the message but later reports that it couldn't deliver it (for example, the number isn't on WhatsApp), the **same code** is sent by SMS automatically.
- Patients can also choose SMS from the start.
