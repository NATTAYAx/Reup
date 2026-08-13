// ─── zoneNames.ts ─────────────────────────────────────────────────────────────
// Searching the zone list for "japan" found nothing, because the identifier is
// "Asia/Tokyo" and the word Japan appears nowhere in it. Neither did "UTC+9",
// because an offset is not part of the string either. Both are the obvious
// things to type, so both have to work.
//
// The runtime can translate a zone name — Asia/Tokyo in Thai is "เวลามาตรฐาน
// ญี่ปุ่น" — but building that for all 418 zones costs about 290 ms and 16 KB,
// which is far too much to spend so that a search box can match a word. So the
// translated name is fetched only for the rows actually on screen, and matching
// runs against this table instead: hand-written, deliberately short, and covering
// the countries someone is actually likely to type rather than every zone that
// exists.
//
// MAJOR does the other half of the job. Nine zones sit at UTC+9 and one of them
// is Asia/Khandyga in Siberia; a list that offers that before Tokyo is technically
// right and practically useless, so the well-known ones sort first.
//
// Several zones appear under two spellings and which one a runtime reports is not
// something to assume: Node here lists Asia/Calcutta, Asia/Saigon, Europe/Kiev
// and Asia/Rangoon, while a newer ICU lists Kolkata, Ho_Chi_Minh, Kyiv and
// Yangon. They are the same zone either way — both spellings work when actually
// converting a time — but a table keyed on only one of them silently loses the
// entry on whichever runtime disagrees. So both are listed.

export const MAJOR_ZONES: ReadonlySet<string> = new Set([
  "UTC",
  "Asia/Bangkok", "Asia/Tokyo", "Asia/Seoul", "Asia/Shanghai", "Asia/Hong_Kong",
  "Asia/Taipei", "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Jakarta",
  "Asia/Ho_Chi_Minh", "Asia/Saigon", "Asia/Manila", "Asia/Yangon", "Asia/Rangoon",
  "Asia/Vientiane", "Asia/Phnom_Penh", "Asia/Kolkata", "Asia/Calcutta",
  "Asia/Karachi", "Asia/Dhaka",
  "Asia/Dubai", "Asia/Riyadh", "Asia/Jerusalem", "Asia/Tehran",
  "Asia/Kathmandu", "Asia/Katmandu",
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Brussels",
  "Europe/Zurich", "Europe/Vienna", "Europe/Prague", "Europe/Warsaw",
  "Europe/Stockholm", "Europe/Oslo", "Europe/Helsinki", "Europe/Copenhagen",
  "Europe/Lisbon", "Europe/Athens", "Europe/Istanbul", "Europe/Moscow", "Europe/Kyiv", "Europe/Kiev",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "America/Toronto", "America/Vancouver", "America/Mexico_City",
  "America/Sao_Paulo", "America/Bogota", "America/Lima",
  "America/Buenos_Aires", "America/Argentina/Buenos_Aires",
  "Pacific/Honolulu", "Pacific/Auckland", "Pacific/Fiji",
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth",
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
]);

/** Extra words that should find a zone, in English and Thai. The city already in
 *  the identifier is not repeated here — that part already matches. */
export const ZONE_ALIASES: Record<string, string> = {
  "UTC": "utc gmt ยูทีซี สากล",
  "Asia/Bangkok": "thailand thai ไทย ประเทศไทย กรุงเทพ กทม",
  "Asia/Tokyo": "japan jp japanese ญี่ปุ่น โตเกียว",
  "Asia/Seoul": "korea south korea kr เกาหลี เกาหลีใต้ โซล",
  "Asia/Shanghai": "china cn chinese beijing peking จีน เซี่ยงไฮ้ ปักกิ่ง",
  "Asia/Hong_Kong": "hongkong hk ฮ่องกง",
  "Asia/Taipei": "taiwan tw ไต้หวัน ไทเป",
  "Asia/Singapore": "sg สิงคโปร์",
  "Asia/Kuala_Lumpur": "malaysia my มาเลเซีย กัวลาลัมเปอร์",
  "Asia/Jakarta": "indonesia id อินโดนีเซีย จาการ์ตา",
  "Asia/Ho_Chi_Minh": "vietnam vn saigon เวียดนาม โฮจิมินห์ ไซ่ง่อน",
  "Asia/Manila": "philippines ph ฟิลิปปินส์ มะนิลา",
  "Asia/Yangon": "myanmar burma mm พม่า เมียนมา ย่างกุ้ง",
  "Asia/Vientiane": "laos la ลาว เวียงจันทน์",
  "Asia/Phnom_Penh": "cambodia kh กัมพูชา พนมเปญ",
  "Asia/Kolkata": "india in calcutta mumbai delhi อินเดีย โกลกาตา มุมไบ เดลี",
  "Asia/Karachi": "pakistan pk ปากีสถาน การาจี",
  "Asia/Dhaka": "bangladesh bd บังกลาเทศ ธากา",
  "Asia/Dubai": "uae emirates ดูไบ สหรัฐอาหรับเอมิเรตส์",
  "Asia/Riyadh": "saudi arabia ซาอุ ซาอุดีอาระเบีย ริยาด",
  "Asia/Jerusalem": "israel il อิสราเอล เยรูซาเล็ม",
  "Asia/Tehran": "iran ir อิหร่าน เตหะราน",
  "Europe/London": "uk england britain british gb อังกฤษ สหราชอาณาจักร ลอนดอน บริเตน",
  "Europe/Dublin": "ireland ie ไอร์แลนด์ ดับลิน",
  "Europe/Paris": "france fr ฝรั่งเศส ปารีส",
  "Europe/Berlin": "germany de german เยอรมนี เยอรมัน เบอร์ลิน",
  "Europe/Madrid": "spain es สเปน มาดริด",
  "Europe/Rome": "italy it อิตาลี โรม",
  "Europe/Amsterdam": "netherlands holland nl เนเธอร์แลนด์ ฮอลแลนด์ อัมสเตอร์ดัม",
  "Europe/Brussels": "belgium be เบลเยียม บรัสเซลส์",
  "Europe/Zurich": "switzerland ch สวิส สวิตเซอร์แลนด์ ซูริก",
  "Europe/Vienna": "austria at ออสเตรีย เวียนนา",
  "Europe/Prague": "czech cz เช็ก ปราก",
  "Europe/Warsaw": "poland pl โปแลนด์ วอร์ซอ",
  "Europe/Stockholm": "sweden se สวีเดน สตอกโฮล์ม",
  "Europe/Oslo": "norway no นอร์เวย์ ออสโล",
  "Europe/Helsinki": "finland fi ฟินแลนด์ เฮลซิงกิ",
  "Europe/Copenhagen": "denmark dk เดนมาร์ก โคเปนเฮเกน",
  "Europe/Lisbon": "portugal pt โปรตุเกส ลิสบอน",
  "Europe/Athens": "greece gr กรีซ เอเธนส์",
  "Europe/Istanbul": "turkey tr ตุรกี อิสตันบูล",
  "Europe/Moscow": "russia ru รัสเซีย มอสโก",
  "Europe/Kyiv": "ukraine ua kiev ยูเครน เคียฟ",
  "America/New_York": "usa us united states america eastern est edt nyc อเมริกา สหรัฐ นิวยอร์ก ฝั่งตะวันออก",
  "America/Chicago": "usa us central cst cdt อเมริกา สหรัฐ ชิคาโก",
  "America/Denver": "usa us mountain mst mdt อเมริกา สหรัฐ เดนเวอร์",
  "America/Los_Angeles": "usa us pacific pst pdt california la sf อเมริกา สหรัฐ ลอสแอนเจลิส แคลิฟอร์เนีย",
  "America/Anchorage": "usa alaska อลาสก้า",
  "America/Toronto": "canada ca แคนาดา โทรอนโต",
  "America/Vancouver": "canada ca แคนาดา แวนคูเวอร์",
  "America/Mexico_City": "mexico mx เม็กซิโก",
  "America/Sao_Paulo": "brazil br บราซิล เซาเปาโล",
  "America/Bogota": "colombia co โคลอมเบีย โบโกตา",
  "America/Lima": "peru pe เปรู ลิมา",
  "America/Buenos_Aires": "argentina ar อาร์เจนตินา บัวโนสไอเรส",
  "Pacific/Honolulu": "usa hawaii ฮาวาย",
  "Pacific/Auckland": "new zealand nz นิวซีแลนด์ โอ๊คแลนด์",
  "Pacific/Fiji": "ฟิจิ",
  "Australia/Sydney": "australia au ออสเตรเลีย ซิดนีย์",
  "Australia/Melbourne": "australia au ออสเตรเลีย เมลเบิร์น",
  "Australia/Brisbane": "australia au ออสเตรเลีย บริสเบน",
  "Australia/Perth": "australia au ออสเตรเลีย เพิร์ท",
  "Africa/Cairo": "egypt eg อียิปต์ ไคโร",
  "Africa/Johannesburg": "south africa za แอฟริกาใต้ โจฮันเนสเบิร์ก",
  "Africa/Lagos": "nigeria ng ไนจีเรีย ลากอส",
  "Africa/Nairobi": "kenya ke เคนยา ไนโรบี",
  // A few zones the runtime names after a city or a meridian rather than the
  // country, so the background index cannot find them by country name.
  "Atlantic/Reykjavik": "iceland is ไอซ์แลนด์ เรคยาวิก",
  "Asia/Ulaanbaatar": "mongolia mn มองโกเลีย อูลานบาตอร์",
  "Europe/Kaliningrad": "russia รัสเซีย คาลินินกราด",
  "Asia/Colombo": "sri lanka lk ศรีลังกา โคลัมโบ",
  "Africa/Casablanca": "morocco ma โมร็อกโก คาซาบลังกา",
  "Asia/Almaty": "kazakhstan kz คาซัคสถาน อัลมาตี",
  // The same zones again under the spelling other runtimes use.
  "Asia/Calcutta": "india in calcutta mumbai delhi อินเดีย โกลกาตา มุมไบ เดลี",
  "Asia/Saigon": "vietnam vn saigon เวียดนาม โฮจิมินห์ ไซ่ง่อน",
  "Europe/Kiev": "ukraine ua kiev ยูเครน เคียฟ",
  "Asia/Rangoon": "myanmar burma mm พม่า เมียนมา ย่างกุ้ง",
  "America/Argentina/Buenos_Aires": "argentina ar อาร์เจนตินา บัวโนสไอเรส",
  "Asia/Kathmandu": "nepal np เนปาล กาฐมาณฑุ",
  "Asia/Katmandu": "nepal np เนปาล กาฐมาณฑุ",
};

/** The alias strings split into words, built once on first search. Word-level
 *  matching is what separates "uk" meaning the United Kingdom from "uk" being
 *  the first two letters of Ukraine: London's aliases contain the whole word,
 *  Kiev's only contain a word that begins with it, and the search ranks the
 *  first above the second. A plain substring test cannot tell them apart. */
let _words: Map<string, string[]> | null = null;
export function aliasWords(zone: string): string[] {
  if (!_words) {
    _words = new Map();
    for (const z in ZONE_ALIASES) _words.set(z, ZONE_ALIASES[z].split(" "));
  }
  return _words.get(zone) ?? [];
}
