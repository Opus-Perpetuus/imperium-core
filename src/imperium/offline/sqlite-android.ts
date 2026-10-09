export const ANDROID_SQLITE_CLASS = "android.database.sqlite.SQLiteDatabase";
export const ANDROID_SYNC_WORKER = "ImperiumSyncWorker";

export function android_background_sync(): {
	mechanism: "WorkManager";
	runs_when_closed: true;
} {
	return { mechanism: "WorkManager", runs_when_closed: true };
}

export function desktop_background_sync(): {
	mechanism: "utility-process";
	runs_when_closed: true;
} {
	return { mechanism: "utility-process", runs_when_closed: true };
}
