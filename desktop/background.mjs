import { z } from "zod";
import { OnboardingStore } from "./onboarding-store.mjs";
const id = "0c785218-9b90-4f2f-b340-4f40a2e4b3b9";
export const BackgroundRequests = {
  appPreferences: z.object({}).strict(),
  setBackground: z.object({ enabled: z.boolean() }).strict(),
  setNotifications: z.object({ enabled: z.boolean() }).strict(),
  takeNotification: z.object({}).strict(),
  setCapacity: z.object({ maximum: z.number().int().min(1).max(256) }).strict(),
  journeyDiagnostics: z.object({}).strict(),
  setJourneyDiagnostics: z.object({ enabled: z.boolean() }).strict(),
  clearJourneyDiagnostics: z.object({}).strict(),
};
export class BackgroundPreference {
  constructor(directory) {
    this.store = new OnboardingStore(
      directory,
      z
        .object({
          id: z.literal(id),
          enabled: z.boolean(),
          maximum: z.number().int().min(1).max(256).optional(),
          diagnostics: z.boolean().optional(),
          notifications: z.boolean().optional(),
        })
        .strict(),
    );
  }
  read() {
    return this.store.read(id)?.enabled ?? false;
  }
  set(enabled) {
    this.store.write({
      ...this.store.read(id),
      id,
      enabled: z.boolean().parse(enabled),
    });
    return this.read();
  }
  capacity() {
    return this.store.read(id)?.maximum ?? null;
  }
  diagnostics() {
    return this.store.read(id)?.diagnostics ?? false;
  }
  notifications() {
    return this.store.read(id)?.notifications ?? false;
  }
  setNotifications(enabled) {
    this.store.write({
      ...this.store.read(id),
      id,
      enabled: this.read(),
      notifications: z.boolean().parse(enabled),
    });
    return this.notifications();
  }
  setDiagnostics(enabled) {
    this.store.write({
      ...this.store.read(id),
      id,
      enabled: this.read(),
      diagnostics: enabled,
    });
  }
  setCapacity(maximum) {
    this.store.write({
      ...this.store.read(id),
      id,
      enabled: this.read(),
      maximum,
    });
  }
}
