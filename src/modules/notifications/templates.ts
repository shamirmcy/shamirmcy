export type Lang = 'en' | 'ta' | 'kn' | 'hi';
export type NotificationEvent =
  | 'otp'
  | 'request_confirmed'
  | 'provider_arriving_soon'
  | 'provider_at_door'
  | 'prescription_ready'
  | 'medicine_out_for_delivery'
  | 'report_ready'
  | 'follow_up_reminder'
  | 'payout_sent'
  | 'no_provider'
  | 'new_request_offer'
  | 'request_cancelled'
  | 'emergency_dispatched'
  | 'rental_ending';

type Tpl = { title: string; body: string };

/**
 * Notification copy. Never include diagnoses, drug names or other health details — only that
 * something is ready to view in the app. `{name}` / `{minutes}` etc. are filled from params.
 */
export const TEMPLATES: Record<NotificationEvent, Record<Lang, Tpl>> = {
  otp: {
    en: { title: 'KM DocH', body: 'Your KM DocH code is {code}. Do not share it.' },
    ta: { title: 'KM DocH', body: 'உங்கள் KM DocH குறியீடு {code}. இதை யாருடனும் பகிர வேண்டாம்.' },
    kn: { title: 'KM DocH', body: 'ನಿಮ್ಮ KM DocH ಕೋಡ್ {code}. ಇದನ್ನು ಯಾರೊಂದಿಗೂ ಹಂಚಿಕೊಳ್ಳಬೇಡಿ.' },
    hi: { title: 'KM DocH', body: 'आपका KM DocH कोड {code} है। इसे किसी से साझा न करें।' },
  },
  request_confirmed: {
    en: { title: 'Visit confirmed', body: '{name} will reach you in about {minutes} minutes.' },
    ta: { title: 'வருகை உறுதி', body: '{name} சுமார் {minutes} நிமிடங்களில் வருவார்.' },
    kn: { title: 'ಭೇಟಿ ದೃಢೀಕರಿಸಲಾಗಿದೆ', body: '{name} ಸುಮಾರು {minutes} ನಿಮಿಷಗಳಲ್ಲಿ ತಲುಪುತ್ತಾರೆ.' },
    hi: { title: 'विज़िट पक्की', body: '{name} लगभग {minutes} मिनट में पहुँचेंगे।' },
  },
  provider_arriving_soon: {
    en: { title: 'Arriving soon', body: '{name} is about {minutes} minutes away. Keep your visit code ready.' },
    ta: { title: 'விரைவில் வருகை', body: '{name} சுமார் {minutes} நிமிடங்களில். வருகைக் குறியீட்டை தயாராக வைத்திருங்கள்.' },
    kn: { title: 'ಶೀಘ್ರದಲ್ಲೇ ಆಗಮನ', body: '{name} ಸುಮಾರು {minutes} ನಿಮಿಷ ದೂರದಲ್ಲಿದ್ದಾರೆ. ಭೇಟಿ ಕೋಡ್ ಸಿದ್ಧವಾಗಿಡಿ.' },
    hi: { title: 'जल्द पहुँच रहे हैं', body: '{name} लगभग {minutes} मिनट दूर हैं। अपना विज़िट कोड तैयार रखें।' },
  },
  provider_at_door: {
    en: { title: 'At your door', body: 'Your KM DocH care professional has arrived.' },
    ta: { title: 'வாசலில்', body: 'உங்கள் KM DocH பராமரிப்பாளர் வந்துவிட்டார்.' },
    kn: { title: 'ನಿಮ್ಮ ಬಾಗಿಲಲ್ಲಿ', body: 'ನಿಮ್ಮ KM DocH ಆರೈಕೆ ವೃತ್ತಿಪರರು ಬಂದಿದ್ದಾರೆ.' },
    hi: { title: 'आपके दरवाज़े पर', body: 'आपके KM DocH देखभाल विशेषज्ञ पहुँच गए हैं।' },
  },
  prescription_ready: {
    en: { title: 'Prescription ready', body: 'Your prescription is ready to view in the app.' },
    ta: { title: 'மருந்துச்சீட்டு தயார்', body: 'உங்கள் மருந்துச்சீட்டை செயலியில் பார்க்கலாம்.' },
    kn: { title: 'ಪ್ರಿಸ್ಕ್ರಿಪ್ಷನ್ ಸಿದ್ಧ', body: 'ನಿಮ್ಮ ಪ್ರಿಸ್ಕ್ರಿಪ್ಷನ್ ಆ್ಯಪ್‌ನಲ್ಲಿ ನೋಡಲು ಸಿದ್ಧವಾಗಿದೆ.' },
    hi: { title: 'पर्चा तैयार', body: 'आपका पर्चा ऐप में देखने के लिए तैयार है।' },
  },
  medicine_out_for_delivery: {
    en: { title: 'Out for delivery', body: 'Your medicines are on the way.' },
    ta: { title: 'டெலிவரிக்கு புறப்பட்டது', body: 'உங்கள் மருந்துகள் வந்துகொண்டிருக்கின்றன.' },
    kn: { title: 'ವಿತರಣೆಗೆ ಹೊರಟಿದೆ', body: 'ನಿಮ್ಮ ಔಷಧಿಗಳು ದಾರಿಯಲ್ಲಿವೆ.' },
    hi: { title: 'डिलीवरी के लिए निकला', body: 'आपकी दवाइयाँ रास्ते में हैं।' },
  },
  report_ready: {
    en: { title: 'Report ready', body: 'Your test report is ready to view in the app.' },
    ta: { title: 'அறிக்கை தயார்', body: 'உங்கள் பரிசோதனை அறிக்கையை செயலியில் பார்க்கலாம்.' },
    kn: { title: 'ವರದಿ ಸಿದ್ಧ', body: 'ನಿಮ್ಮ ಪರೀಕ್ಷಾ ವರದಿ ಆ್ಯಪ್‌ನಲ್ಲಿ ಸಿದ್ಧವಾಗಿದೆ.' },
    hi: { title: 'रिपोर्ट तैयार', body: 'आपकी जाँच रिपोर्ट ऐप में देखने के लिए तैयार है।' },
  },
  follow_up_reminder: {
    en: { title: 'Follow-up reminder', body: 'Your doctor asked for a follow-up. Book it in the app.' },
    ta: { title: 'தொடர் பரிசோதனை நினைவூட்டல்', body: 'உங்கள் மருத்துவர் தொடர் பரிசோதனை பரிந்துரைத்துள்ளார். செயலியில் பதிவு செய்யுங்கள்.' },
    kn: { title: 'ಫಾಲೋ-ಅಪ್ ಜ್ಞಾಪನೆ', body: 'ನಿಮ್ಮ ವೈದ್ಯರು ಫಾಲೋ-ಅಪ್ ಸೂಚಿಸಿದ್ದಾರೆ. ಆ್ಯಪ್‌ನಲ್ಲಿ ಬುಕ್ ಮಾಡಿ.' },
    hi: { title: 'फ़ॉलो-अप याद दिलाना', body: 'आपके डॉक्टर ने फ़ॉलो-अप कहा है। ऐप में बुक करें।' },
  },
  payout_sent: {
    en: { title: 'Payout sent', body: '{amount} has been sent to your account.' },
    ta: { title: 'பணம் அனுப்பப்பட்டது', body: '{amount} உங்கள் கணக்கிற்கு அனுப்பப்பட்டது.' },
    kn: { title: 'ಪಾವತಿ ಕಳುಹಿಸಲಾಗಿದೆ', body: '{amount} ನಿಮ್ಮ ಖಾತೆಗೆ ಕಳುಹಿಸಲಾಗಿದೆ.' },
    hi: { title: 'भुगतान भेजा गया', body: '{amount} आपके खाते में भेज दिया गया है।' },
  },
  no_provider: {
    en: { title: 'No one available right now', body: 'We could not find a care professional nearby. You can schedule for later.' },
    ta: { title: 'இப்போது யாரும் இல்லை', body: 'அருகில் பராமரிப்பாளர் கிடைக்கவில்லை. பின்னர் திட்டமிடலாம்.' },
    kn: { title: 'ಈಗ ಯಾರೂ ಲಭ್ಯವಿಲ್ಲ', body: 'ಹತ್ತಿರದಲ್ಲಿ ಆರೈಕೆ ವೃತ್ತಿಪರರು ಸಿಗಲಿಲ್ಲ. ನಂತರಕ್ಕೆ ನಿಗದಿಪಡಿಸಬಹುದು.' },
    hi: { title: 'अभी कोई उपलब्ध नहीं', body: 'पास में कोई देखभाल विशेषज्ञ नहीं मिला। आप बाद के लिए शेड्यूल कर सकते हैं।' },
  },
  new_request_offer: {
    en: { title: 'New request', body: 'A new {service} request is waiting for you.' },
    ta: { title: 'புதிய கோரிக்கை', body: 'புதிய {service} கோரிக்கை உங்களுக்காக காத்திருக்கிறது.' },
    kn: { title: 'ಹೊಸ ವಿನಂತಿ', body: 'ಹೊಸ {service} ವಿನಂತಿ ನಿಮಗಾಗಿ ಕಾಯುತ್ತಿದೆ.' },
    hi: { title: 'नया अनुरोध', body: 'एक नया {service} अनुरोध आपका इंतज़ार कर रहा है।' },
  },
  request_cancelled: {
    en: { title: 'Request cancelled', body: 'A request assigned to you was cancelled.' },
    ta: { title: 'கோரிக்கை ரத்து', body: 'உங்களுக்கு ஒதுக்கப்பட்ட கோரிக்கை ரத்து செய்யப்பட்டது.' },
    kn: { title: 'ವಿನಂತಿ ರದ್ದು', body: 'ನಿಮಗೆ ನಿಯೋಜಿಸಲಾದ ವಿನಂತಿಯನ್ನು ರದ್ದುಪಡಿಸಲಾಗಿದೆ.' },
    hi: { title: 'अनुरोध रद्द', body: 'आपको सौंपा गया अनुरोध रद्द कर दिया गया।' },
  },
  emergency_dispatched: {
    en: { title: 'Ambulance dispatched', body: 'An ambulance is on the way. You can also call {emergency_number}.' },
    ta: { title: 'ஆம்புலன்ஸ் அனுப்பப்பட்டது', body: 'ஆம்புலன்ஸ் வந்துகொண்டிருக்கிறது. {emergency_number} ஐயும் அழைக்கலாம்.' },
    kn: { title: 'ಆಂಬ್ಯುಲೆನ್ಸ್ ಕಳುಹಿಸಲಾಗಿದೆ', body: 'ಆಂಬ್ಯುಲೆನ್ಸ್ ದಾರಿಯಲ್ಲಿದೆ. {emergency_number} ಗೆ ಕೂಡ ಕರೆ ಮಾಡಬಹುದು.' },
    hi: { title: 'एम्बुलेंस रवाना', body: 'एम्बुलेंस रास्ते में है। आप {emergency_number} पर भी कॉल कर सकते हैं।' },
  },
  rental_ending: {
    en: { title: 'Rental ending soon', body: 'Your equipment rental ends on {date}. Extend or arrange pickup in the app.' },
    ta: { title: 'வாடகை முடிவடைகிறது', body: 'உங்கள் உபகரண வாடகை {date} அன்று முடிகிறது. செயலியில் நீட்டிக்கவும்.' },
    kn: { title: 'ಬಾಡಿಗೆ ಮುಕ್ತಾಯ', body: 'ನಿಮ್ಮ ಉಪಕರಣ ಬಾಡಿಗೆ {date} ರಂದು ಮುಗಿಯುತ್ತದೆ. ಆ್ಯಪ್‌ನಲ್ಲಿ ವಿಸ್ತರಿಸಿ.' },
    hi: { title: 'किराया समाप्त होने वाला है', body: 'आपका उपकरण किराया {date} को समाप्त होगा। ऐप में बढ़ाएँ या वापसी तय करें।' },
  },
};

export function render(event: NotificationEvent, lang: Lang, params: Record<string, string | number>): Tpl {
  const t = TEMPLATES[event][lang] ?? TEMPLATES[event].en;
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
  return { title: fill(t.title), body: fill(t.body) };
}
