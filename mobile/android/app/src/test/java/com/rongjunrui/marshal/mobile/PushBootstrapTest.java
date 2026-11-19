package com.rongjunrui.marshal.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.google.firebase.FirebaseApp;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PushBootstrapTest {
    @Test
    public void skipsTheTokenCallWhenFirebaseIsNotConfigured() {
        boolean[] called = { false };
        PushBootstrap.readFirebase(new PushBootstrap.FirebaseTokens() {
            @Override public boolean configured() { return false; }
            @Override public void requestToken() { called[0] = true; }
        });
        assertFalse(called[0]);
    }

    @Test
    public void swallowsATokenFailure() {
        PushBootstrap.readFirebase(new PushBootstrap.FirebaseTokens() {
            @Override public boolean configured() { return true; }
            @Override public void requestToken() { throw new IllegalStateException("FirebaseApp is not initialized"); }
        });
    }

    @Test
    public void launchesWithoutGoogleServicesOrHuaweiConfig() {
        Context context = ApplicationProvider.getApplicationContext();
        assertTrue(FirebaseApp.getApps(context).isEmpty());
        PushBootstrap.readFirebase(context);
    }
}
