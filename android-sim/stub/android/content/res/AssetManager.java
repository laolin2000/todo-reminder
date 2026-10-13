package android.content.res;

import java.io.IOException;
import java.io.InputStream;

/** 最小 JVM 替身 */
public class AssetManager {
    public String[] list(String path) { return new String[0]; }
    public InputStream open(String path) throws IOException { throw new IOException("stub assets"); }
}
