"""Latest "iOS native" run on a branch: status, jobs and error annotations (public API, no token)."""
import json, sys, urllib.request

REPO = "harunhusey556-hub/lashkirja"
API = f"https://api.github.com/repos/{REPO}"


def get(url):
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def main(branch):
    runs = [r for r in get(f"{API}/actions/runs?branch={branch}&per_page=10")["workflow_runs"] if r["name"] == "iOS native"]
    if not runs:
        print("no run")
        return 1
    run = runs[0]
    print(run["head_sha"][:7], run["status"], run["conclusion"], run["html_url"])
    for job in get(f"{API}/actions/runs/{run['id']}/jobs")["jobs"]:
        print(f"- {job['name']}: {job['status']} {job['conclusion']}")
        for a in get(f"{API}/check-runs/{job['id']}/annotations")[:40]:
            print(f"    {a['annotation_level']} {a['path']}:{a['start_line']} {a['message'][:300]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "native"))
