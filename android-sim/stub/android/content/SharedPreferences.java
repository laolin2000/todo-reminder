package android.content;

import java.util.Map;
import java.util.HashMap;

/** 最小 JVM 替身(内存实现, 仅避免运行期 NPE) */
public class SharedPreferences {
    private final Map<String, Object> m = new HashMap<String, Object>();

    public String getString(String key, String def) {
        Object v = m.get(key);
        return v instanceof String ? (String) v : def;
    }

    public long getLong(String key, long def) {
        Object v = m.get(key);
        return v instanceof Long ? (Long) v : def;
    }

    public Editor edit() { return new Editor(); }

    public class Editor {
        public Editor putString(String key, String val) { m.put(key, val); return this; }
        public Editor putLong(String key, long val) { m.put(key, val); return this; }
        public void apply() { }
    }
}
