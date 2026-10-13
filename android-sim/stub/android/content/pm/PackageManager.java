package android.content.pm;

/** 最小 JVM 替身 */
public class PackageManager {
    public PackageInfo getPackageInfo(String packageName, int flags) { return new PackageInfo(); }
}
