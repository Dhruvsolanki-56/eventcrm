export type AnalyticsData = {
  period: { days: number; from: string; to: string; timeZone: string };
  selectedEventId: string;
  events: Array<{ id: string; name: string }>;
  metrics: { people: number; previousPeople: number; companies: number; conversations: number; openValue: number; wonValue: number; wonCompanies: number; openDeals: number; wonDeals: number; contactable: number };
  daily: Array<{ day: string; people: number; conversations: number }>;
  stages: Array<{ stage: string; people: number }>;
  quality: Array<{ quality: string; people: number }>;
  sources: Array<{ id: string; name: string; people: number; conversations: number }>;
  recent: Array<{ id: string; name: string; company: string; stage: string; quality: string | null; lastEncounter: string }>;
  workflow: { captured: number; reviewed: number; draftsPrepared: number; userApproved: number; serverAccepted: number; repliesRecorded: number; medianCaptureToReviewMinutes: number | null; medianConversationToDraftMinutes: number | null; events: Array<{ id: string; name: string; captured: number; reviewed: number; draftsPrepared: number; userApproved: number; serverAccepted: number; repliesRecorded: number }> };
};
