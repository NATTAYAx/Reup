import type { SelectOption } from "../components/Select";
import { t } from "./i18n";

// The six reset types, with a line each saying what picking one actually does.
// Shared by the add and edit forms so the wording cannot drift apart, and built
// once at import: the list never changes, and changing the app language reloads
// the window anyway.
export const TYPE_OPTIONS: SelectOption[] = [
  { value: "daily",         icon: "🔄", label: t("type.daily"),         hint: t("resetHint.daily") },
  { value: "weekly",        icon: "📅", label: t("type.weekly"),        hint: t("resetHint.weekly") },
  { value: "biweekly",      icon: "🗓️", label: t("type.biweekly"),      hint: t("resetHint.biweekly") },
  { value: "custom_days",   icon: "⏱️", label: t("type.custom_days"),   hint: t("resetHint.custom_days") },
  { value: "event_window",  icon: "🎌", label: t("type.event_window"),  hint: t("resetHint.event_window") },
  { value: "specific_date", icon: "📌", label: t("type.specific_date"), hint: t("resetHint.specific_date") },
];