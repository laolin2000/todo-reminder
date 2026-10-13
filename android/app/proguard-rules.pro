# 保留 OKHttp 等库的混淆规则(当前未开启 minify, 预留)
-keepattributes Signature
-keepattributes *Annotation*
-dontwarn okhttp3.**
-dontwarn okio.**
