package kr.funnet.tvcontroller.data;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SecureTokenStore {
    private static final String ALIAS = "funnet-tv-controller-token";
    private final SharedPreferences preferences;

    public SecureTokenStore(Context context) {
        preferences = context.getSharedPreferences("secure_device_identity", Context.MODE_PRIVATE);
    }

    public synchronized void save(String deviceId, String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        preferences.edit()
                .putString("deviceId", deviceId)
                .putString("tokenIv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString("tokenCipher", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .apply();
    }

    public synchronized Credentials load() {
        String deviceId = preferences.getString("deviceId", "");
        String iv = preferences.getString("tokenIv", "");
        String encrypted = preferences.getString("tokenCipher", "");
        if (deviceId.isBlank() || iv.isBlank() || encrypted.isBlank()) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                    new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            String token = new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            return new Credentials(deviceId, token);
        } catch (Exception error) {
            clear();
            return null;
        }
    }

    public void clear() { preferences.edit().clear().apply(); }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    public record Credentials(String deviceId, String token) {}
}
