package com.nakauri.hrmonitor;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.activity.result.contract.ActivityResultContract;
import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.PermissionController;
import androidx.health.connect.client.records.SleepSessionRecord;
import androidx.health.connect.client.request.ReadRecordsRequest;
import androidx.health.connect.client.response.ReadRecordsResponse;
import androidx.health.connect.client.time.TimeRangeFilter;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import kotlin.jvm.JvmClassMappingKt;

/** The only class that touches the Health Connect client. Load it on API 28+ only. */
@SuppressWarnings({"rawtypes", "unchecked"})
final class HcClient {
    static final String SETTINGS_ACTION = "androidx.health.ACTION_HEALTH_CONNECT_SETTINGS";

    private HcClient() {}

    static int sdkStatus(Context ctx) {
        return HealthConnectClient.getSdkStatus(ctx, HcMap.PROVIDER);
    }

    static boolean installed(Context ctx) {
        try {
            ctx.getPackageManager().getPackageInfo(HcMap.PROVIDER, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static Set<String> granted(Context ctx) throws Throwable {
        PermissionController pc = HealthConnectClient.getOrCreate(ctx).getPermissionController();
        Object r = HcAwait.await(c -> pc.getGrantedPermissions(c), HcAwait.TIMEOUT_MS);
        return r instanceof Set ? (Set<String>) r : new HashSet<>();
    }

    static Intent permissionIntent(Context ctx, Set<String> perms) {
        ActivityResultContract<Set<String>, Set<String>> k = PermissionController.createRequestPermissionResultContract();
        return k.createIntent(ctx, perms);
    }

    static Set<String> parseGranted(int resultCode, Intent data) {
        ActivityResultContract<Set<String>, Set<String>> k = PermissionController.createRequestPermissionResultContract();
        Set<String> s = k.parseResult(resultCode, data);
        return s != null ? s : new HashSet<>();
    }

    /** Sleep sessions in [from, to]. Any page failure throws: no partial rows. */
    static HcMap.Rows readSleep(Context ctx, long fromMs, long toMs, HcAwait.Lease lease) throws Throwable {
        HealthConnectClient client = HealthConnectClient.getOrCreate(ctx);
        TimeRangeFilter range = TimeRangeFilter.between(Instant.ofEpochMilli(fromMs), Instant.ofEpochMilli(toMs));
        HcMap.Rows out = new HcMap.Rows();
        String token = null;
        do {
            ReadRecordsRequest req = new ReadRecordsRequest(
                JvmClassMappingKt.getKotlinClass(SleepSessionRecord.class), range, new HashSet<>(), true, 1000, token);
            ReadRecordsResponse resp = (ReadRecordsResponse) HcAwait.await(c -> client.readRecords(req, c), HcAwait.TIMEOUT_MS, lease);
            List recs = resp.getRecords();
            for (Object o : recs) {
                SleepSessionRecord r = (SleepSessionRecord) o;
                List<SleepSessionRecord.Stage> st = r.getStages();
                long[][] stages = new long[st.size()][];
                for (int i = 0; i < st.size(); i++) {
                    SleepSessionRecord.Stage x = st.get(i);
                    stages[i] = new long[] { x.getStartTime().toEpochMilli(), x.getEndTime().toEpochMilli(), x.getStage() };
                }
                if (!out.add(HcMap.sleepRow(r.getMetadata().getId(), r.getMetadata().getDataOrigin().getPackageName(),
                    r.getStartTime().toEpochMilli(), r.getEndTime().toEpochMilli(), stages))) return out;
            }
            token = resp.getPageToken();
        } while (token != null && !token.isEmpty());
        return out;
    }
}
