package android.content;

import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import java.io.File;

/** 最小 JVM 替身(仅编译/运行 android-web 服务端所需成员) */
public abstract class Context {
    public static final int MODE_PRIVATE = 0;
    public File getFilesDir() { return null; }
    public Context getApplicationContext() { return null; }
    public AssetManager getAssets() { return null; }
    public String getPackageName() { return null; }
    public PackageManager getPackageManager() { return null; }
    public SharedPreferences getSharedPreferences(String name, int mode) { return new SharedPreferences(); }
}
