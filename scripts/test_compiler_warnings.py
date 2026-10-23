"""Unit tests for compiler-warnings.py (N002): a warning in a file under ios-native/ is reported once with its
file, line and column, in the lines `swift test` and `xcodebuild` really print (copied from the runs on
native 1213b6c); the SDK's, the checked-out packages' and Xcode's own tools' are not, and an empty log fails.
usage: python3 -m unittest discover -s scripts -p 'test_compiler_warnings.py'"""
import importlib.util, io, os, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("compiler_warnings", os.path.join(HERE, "compiler-warnings.py"))
compiler_warnings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler_warnings)

LINUX = "/home/runner/work/lashkirja/lashkirja/ios-native/LashKirjaCore"
MAC = "/Users/runner/work/lashkirja/lashkirja/ios-native/App"
DECODER = "'nonisolated(unsafe)' is unnecessary for a constant with 'Sendable' type 'JSONDecoder', consider removing it"


def run(log):
    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "build.log")
        with open(path, "w", encoding="utf-8") as f:
            f.write(log)
        out = io.StringIO()
        with redirect_stdout(out):
            status = compiler_warnings.main(["compiler-warnings.py", path])
        return status, out.getvalue()


class CompilerWarnings(unittest.TestCase):
    def test_a_swift_test_warning_is_reported_with_its_place(self):
        log = f"{LINUX}/Sources/LashKirjaCore/Chat/Chat.swift:334:5: warning: {DECODER}\n"
        self.assertEqual(compiler_warnings.warnings(log),
                         [("ios-native/LashKirjaCore/Sources/LashKirjaCore/Chat/Chat.swift", 334, 5, DECODER)])

    def test_an_xcodebuild_warning_is_reported_with_its_place(self):
        log = f"{MAC}/Tests/LashKirjaUITests/P1Tests.swift:149:9: warning: result of call to 'tap' is unused\n"
        self.assertEqual(compiler_warnings.warnings(log),
                         [("ios-native/App/Tests/LashKirjaUITests/P1Tests.swift", 149, 9, "result of call to 'tap' is unused")])

    def test_the_second_architecture_and_the_source_excerpt_do_not_count_again(self):
        # `swift test` repeats the warning in its excerpt (`|     `- warning: ...`); xcodebuild prints it per architecture.
        log = (f"{LINUX}/Sources/LashKirjaCore/Chat/Chat.swift:334:5: warning: {DECODER}\n"
               "332 | \n"
               "334 |     nonisolated(unsafe) private static let decoder = JSONDecoder()\n"
               f"    |     `- warning: {DECODER}\n"
               f"{LINUX}/Sources/LashKirjaCore/Chat/Chat.swift:334:5: warning: {DECODER}\n")
        self.assertEqual(len(compiler_warnings.warnings(log)), 1)

    def test_colour_codes_around_the_words_do_not_hide_a_warning(self):
        log = f"\x1b[1m{LINUX}/Sources/LashKirjaCore/Chat/Chat.swift:334:5: \x1b[0m\x1b[1;35mwarning: \x1b[0m{DECODER}\n"
        self.assertEqual(len(compiler_warnings.warnings(log)), 1)

    def test_warnings_that_differ_in_place_are_each_reported(self):
        # DeviceKey's two before N002: the same words, two places.
        log = (f"{MAC}/Sources/DeviceKey.swift:33:39: warning: will never be executed\n"
               f"{MAC}/Sources/DeviceKey.swift:42:56: warning: will never be executed\n")
        self.assertEqual([(w[1], w[2]) for w in compiler_warnings.warnings(log)], [(33, 39), (42, 56)])

    def test_the_package_warning_about_unhandled_files_is_reported(self):
        log = ("warning: 'lashkirjacore': found 19 file(s) which are unhandled; explicitly declare them as "
               "resources or exclude from the target\n"
               f"    {LINUX}/Tests/LashKirjaCoreTests/Fixtures/profile.json\n")
        found = compiler_warnings.warnings(log)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0][0], "")
        self.assertIn("19 file(s) which are unhandled", found[0][3])

    def test_a_warning_in_a_built_or_checked_out_file_is_not_the_repos(self):
        log = (f"{MAC}/build/SourcePackages/checkouts/stripe-terminal-ios-spm/Sources/Foo.swift:1:1: warning: x\n"
               f"{MAC}/build/Build/Intermediates.noindex/GeneratedAssetSymbols.swift:9:9: warning: y\n"
               f"{LINUX}/.build/checkouts/dep/Sources/Dep.swift:2:2: warning: z\n"
               "/Applications/Xcode_26.6.app/Contents/Developer/SDKs/iPhoneOS.sdk/Foo.h:3:3: warning: w\n")
        self.assertEqual(compiler_warnings.warnings(log), [])

    def test_the_tools_and_the_destination_notes_are_not_compiler_warnings(self):
        log = ("2026-10-22 00:48:51.192 appintentsmetadataprocessor[39906:109246] warning: Metadata extraction skipped. "
               "No AppIntents.framework dependency found.\n"
               "--- xcodebuild: WARNING: Using the first of multiple matching destinations:\n"
               "hint: to use in all of your new repositories, which will suppress this warning,\n")
        self.assertEqual(compiler_warnings.warnings(log), [])

    def test_a_project_file_warning_without_a_line_is_reported(self):
        log = f"{MAC}/LashKirja.xcodeproj: warning: Run script build phase 'Stripe' will be run during every build\n"
        self.assertEqual(compiler_warnings.warnings(log),
                         [("ios-native/App/LashKirja.xcodeproj", 0, 0, "Run script build phase 'Stripe' will be run during every build")])

    def test_main_annotates_each_warning_and_fails_only_when_there_is_one(self):
        status, out = run(f"{MAC}/Sources/AppModel.swift:186:17: warning: reference to captured var 'model'\n")
        self.assertEqual(status, 1)
        self.assertIn("::error file=ios-native/App/Sources/AppModel.swift,line=186,col=17::reference to captured var", out)
        status, out = run("[1/9] Compiling LashKirjaCore Chat.swift\nBuild complete!\n")
        self.assertEqual(status, 0)
        self.assertIn("0 compiler warning(s)", out)

    def test_an_empty_log_is_a_failed_capture_not_a_clean_build(self):
        status, out = run("\n")
        self.assertEqual(status, 2)
        self.assertIn("is empty", out)


if __name__ == "__main__":
    unittest.main()
