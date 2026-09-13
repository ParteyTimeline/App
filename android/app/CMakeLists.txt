cmake_minimum_required(VERSION 3.22.1)
project("parteytimeline-nearby")

# Bridges Java/Kotlin to the nodejs-mobile prebuilt libnode.so — see
# https://github.com/nodejs-mobile/nodejs-mobile (Android release asset)
# and scripts/fetch-libnode.sh, which downloads the four ABI builds into
# app/libnode/bin/<abi>/libnode.so.
add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

include_directories(libnode/include/node/)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(native-lib libnode ${log-lib})
