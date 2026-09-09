"use client";

import { useEffect, useState, useTransition, type UIEvent } from "react";
import {
  X,
  Loader2,
  Plus,
  ChevronsUpDown,
  CirclePlus,
  TriangleAlert,
  ExternalLink,
  Check,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  searchAtsCompanies,
  resolveAtsBoard,
  getAtsCompanyCount,
} from "@/actions/atsCompany.actions";
import { getAllJobTitles, createJobTitle } from "@/actions/jobtitle.actions";
import { getAllTags, createTag } from "@/actions/tag.actions";
import { getAllJobLocations } from "@/actions/jobLocation.actions";
import { createLocation } from "@/actions/job.actions";
import { toastError } from "@/lib/toast";
import { APP_CONSTANTS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type {
  JobBoard,
  LeverCompany,
  LeverSourceConfig,
} from "@/models/automation.model";
import { companyBoardUrl } from "@/lib/atsBoardUrl";

// The step is provider-agnostic; it edits the canonical Lever config shape — a
// superset of Greenhouse's, where the extra per-company `host` is unused and
// UI-invisible for Greenhouse.
export type AtsConfigValue = LeverSourceConfig;

interface AtsSearchStepProps {
  provider: JobBoard;
  value: AtsConfigValue;
  onChange: (next: AtsConfigValue) => void;
}

const PROVIDER_META: Record<
  string,
  { label: string; urlHint: string; searchExample: string }
> = {
  greenhouse: {
    label: "Greenhouse",
    urlHint: "Or paste a boards.greenhouse.io link",
    searchExample: "Anthropic",
  },
  lever: {
    label: "Lever",
    urlHint: "Or paste a jobs.lever.co link or token",
    searchExample: "Netflix",
  },
};

type EntityOption = {
  id: string;
  label: string;
  value: string;
};

// Generic chip input that searches existing DB entities and can create new ones.
// `values` is a string[] of labels (not IDs) stored in the source config.
function EntityStringChipInput({
  label,
  description,
  placeholder,
  noun,
  values,
  onChange,
  loadOptions,
  createOption,
}: {
  label: string;
  description: string;
  placeholder: string;
  noun: string;
  values: string[];
  onChange: (next: string[]) => void;
  loadOptions: () => Promise<EntityOption[]>;
  createOption: (label: string) => Promise<EntityOption | null>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, startCreate] = useTransition();

  const handleOpen = (next: boolean) => {
    setOpen(next);

    if (next && !loaded) {
      setIsLoading(true);

      loadOptions()
        .then((opts) => {
          setOptions(Array.isArray(opts) ? opts : []);
          setLoaded(true);
        })
        .catch(() => {})
        .finally(() => setIsLoading(false));
    }
  };

  const inputLower = input.trim().toLowerCase();

  const filtered = options.filter(
    (o) =>
      !values.includes(o.label) &&
      o.label.toLowerCase().includes(inputLower),
  );

  /*
   * All options matching the current search.
   *
   * This includes already-selected options because Select All / Deselect All
   * needs to know about them.
   */
  const matchingOptions = options.filter((o) =>
    o.label.toLowerCase().includes(inputLower),
  );

  const allMatchingSelected =
    matchingOptions.length > 0 &&
    matchingOptions.every((o) => values.includes(o.label));

  const addLabel = (lbl: string) => {
    const trimmed = lbl.trim();

    if (!trimmed || values.includes(trimmed)) return;

    onChange([...values, trimmed]);
    setInput("");
    setOpen(false);
  };

  /*
   * Select all / deselect all options matching the current search.
   *
   * If the search box is empty, this operates on all loaded options.
   * If the user has typed something, it operates only on matching options.
   */
  const toggleSelectAll = () => {
    if (matchingOptions.length === 0) return;

    if (allMatchingSelected) {
      const matchingLabels = new Set(
        matchingOptions.map((o) => o.label),
      );

      onChange(
        values.filter(
          (value) => !matchingLabels.has(value),
        ),
      );

      return;
    }

    const existingValues = new Set(values);

    const valuesToAdd = matchingOptions
      .filter((o) => !existingValues.has(o.label))
      .map((o) => o.label);

    if (valuesToAdd.length === 0) return;

    onChange([...values, ...valuesToAdd]);
  };

  const exactMatch = options.some(
    (o) => o.value === inputLower,
  );

  const alreadyAdded = values.some(
    (v) => v.toLowerCase() === inputLower,
  );

  const handleCreate = () => {
    const lbl = input.trim();

    if (!lbl || alreadyAdded || isCreating) return;

    startCreate(async () => {
      const created = await createOption(lbl);

      if (!created) {
        toastError(`Failed to create ${noun}.`);
        return;
      }

      setOptions((prev) =>
        prev.some((o) => o.id === created.id)
          ? prev
          : [...prev, created],
      );

      addLabel(created.label);
    });
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>

      <Popover
        open={open}
        onOpenChange={handleOpen}
        modal
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal text-muted-foreground"
          >
            {values.length > 0
              ? `${values.length} ${noun}${
                  values.length === 1 ? "" : "s"
                } selected`
              : placeholder}

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronsUpDown className="h-4 w-4 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          className="p-0 w-(--radix-popover-trigger-width)"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`Search or create ${noun}...`}
              value={input}
              onValueChange={setInput}
            />

            <CommandList>
              {isLoading && (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading...
                </div>
              )}

              {!isLoading &&
                matchingOptions.length > 0 && (
                  <CommandGroup>
                    {/* Select All / Deselect All */}
                    <CommandItem
                      value="__select_all__"
                      onSelect={toggleSelectAll}
                      className="font-medium"
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          allMatchingSelected
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />

                      <span>
                        {allMatchingSelected
                          ? "Deselect all"
                          : "Select all"}
                      </span>

                      <span className="ml-auto text-xs text-muted-foreground">
                        {matchingOptions.length}{" "}
                        {noun}
                        {matchingOptions.length === 1
                          ? ""
                          : "s"}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}

              {!isLoading &&
                !input.trim() &&
                filtered.length === 0 &&
                matchingOptions.length === 0 && (
                  <CommandEmpty>
                    No {noun}s found. Type to create one.
                  </CommandEmpty>
                )}

              {input.trim() && alreadyAdded && filtered.length === 0 && (
                <CommandEmpty>
                  Already added.
                </CommandEmpty>
              )}

              {filtered.length > 0 && (
                <CommandGroup>
                  {filtered.map((o) => {
                    const selected = values.includes(
                      o.label,
                    );

                    return (
                      <CommandItem
                        key={o.id}
                        value={o.value}
                        onSelect={() =>
                          addLabel(o.label)
                        }
                      >
                        <Check
                          className={cn(
                            "h-4 w-4 mr-2",
                            selected
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />

                        {o.label}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {input.trim() &&
                !exactMatch &&
                !alreadyAdded && (
                  <CommandGroup>
                    <CommandItem
                      onSelect={handleCreate}
                      disabled={isCreating}
                      className="text-primary"
                    >
                      {isCreating ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <CirclePlus className="h-4 w-4 mr-2" />
                      )}

                      Create &quot;{input.trim()}&quot;
                    </CommandItem>
                  </CommandGroup>
                )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="gap-1"
            >
              {v}

              <button
                type="button"
                onClick={() =>
                  onChange(
                    values.filter(
                      (x) => x !== v,
                    ),
                  )
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export function AtsSearchStep({
  provider,
  value,
  onChange,
}: AtsSearchStepProps) {
  const meta =
    PROVIDER_META[provider] ??
    PROVIDER_META.greenhouse;

  const companies = value.companies ?? [];

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    LeverCompany[]
  >([]);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<
    number | null
  >(null);
  const [open, setOpen] = useState(false);
  const [isSearching, startSearch] =
    useTransition();

  const [urlInput, setUrlInput] = useState("");
  const [isResolving, setIsResolving] =
    useState(false);
  const [urlError, setUrlError] = useState<
    string | null
  >(null);

  useEffect(() => {
    getAtsCompanyCount(provider)
      .then(setTotalCount)
      .catch(() => {});
  }, [provider]);

  // offset 0 replaces the list (new query / reopen);
  // a positive offset appends the next page (infinite scroll).
  const runSearch = (
    q: string,
    offset = 0,
  ) => {
    startSearch(async () => {
      const {
        companies: found,
        hasMore: more,
      } = await searchAtsCompanies(
        provider,
        q,
        offset,
      );

      setResults((prev) => {
        if (offset === 0) return found;

        const seen = new Set(
          prev.map((c) => c.token),
        );

        return [
          ...prev,
          ...found.filter(
            (c) => !seen.has(c.token),
          ),
        ];
      });

      setHasMore(more);
    });
  };

  const handleQueryChange = (
    val: string,
  ) => {
    setQuery(val);
    runSearch(val, 0);
  };

  const handleOpen = (
    next: boolean,
  ) => {
    setOpen(next);

    if (next) {
      runSearch(query, 0);
    }
  };

  const handleListScroll = (
    e: UIEvent<HTMLDivElement>,
  ) => {
    if (!hasMore || isSearching) return;

    const el = e.currentTarget;

    if (
      el.scrollHeight -
        el.scrollTop -
        el.clientHeight <
      48
    ) {
      runSearch(
        query,
        results.length,
      );
    }
  };

  const addCompany = (
    company: LeverCompany,
  ) => {
    if (
      companies.some(
        (c) => c.token === company.token,
      )
    ) {
      return;
    }

    if (
      companies.length >=
      APP_CONSTANTS.MAX_GREENHOUSE_COMPANIES
    ) {
      return;
    }

    onChange({
      ...value,
      companies: [
        ...companies,
        company,
      ],
    });
  };

  const removeCompany = (
    token: string,
  ) => {
    onChange({
      ...value,
      companies:
        companies.filter(
          (c) => c.token !== token,
        ),
    });
  };

  const toggleCompany = (
    company: LeverCompany,
  ) => {
    if (
      companies.some(
        (c) => c.token === company.token,
      )
    ) {
      removeCompany(company.token);
    } else {
      addCompany(company);
    }
  };

  /*
   * Select all currently loaded company results.
   * Respects MAX_GREENHOUSE_COMPANIES.
   */
  const selectAllResults = () => {
    const allSelected =
      results.length > 0 &&
      results.every((c) =>
        companies.some(
          (sel) =>
            sel.token === c.token,
        ),
      );

    // Deselect all currently loaded results.
    if (allSelected) {
      const resultTokens = new Set(
        results.map((c) => c.token),
      );

      onChange({
        ...value,
        companies:
          companies.filter(
            (c) =>
              !resultTokens.has(
                c.token,
              ),
          ),
      });

      return;
    }

    const remainingSlots =
      APP_CONSTANTS.MAX_GREENHOUSE_COMPANIES -
      companies.length;

    if (remainingSlots <= 0) return;

    const selectedTokens = new Set(
      companies.map(
        (c) => c.token,
      ),
    );

    const companiesToAdd = results
      .filter(
        (c) =>
          !selectedTokens.has(
            c.token,
          ),
      )
      .slice(0, remainingSlots);

    if (companiesToAdd.length === 0)
      return;

    onChange({
      ...value,
      companies: [
        ...companies,
        ...companiesToAdd,
      ],
    });
  };

  const allResultsSelected =
    results.length > 0 &&
    results.every((c) =>
      companies.some(
        (sel) =>
          sel.token === c.token,
      ),
    );

  const atLimit =
    companies.length >=
    APP_CONSTANTS.MAX_GREENHOUSE_COMPANIES;

  const resolveUrl = async () => {
    setUrlError(null);
    setIsResolving(true);

    try {
      const result =
        await resolveAtsBoard(
          provider,
          urlInput,
        );

      if (result.success) {
        addCompany({
          name: result.name,
          token: result.token,
          ...(result.host
            ? { host: result.host }
            : {}),
        });

        setUrlInput("");
      } else {
        setUrlError(
          result.message,
        );
      }
    } finally {
      setIsResolving(false);
    }
  };

  const noSignal =
    (value.targetTitles?.length ?? 0) ===
      0 &&
    (value.keywords?.length ?? 0) ===
      0;

  return (
    <div className="space-y-5">
      {/* Companies */}
      <div className="space-y-2">
        <Label className="flex items-center justify-between">
          <span>
            {meta.label} Companies{" "}
            <span className="font-normal text-muted-foreground">
              ({companies.length}/
              {
                APP_CONSTANTS.MAX_GREENHOUSE_COMPANIES
              })
            </span>
          </span>

          {totalCount !== null &&
            totalCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                {totalCount} available
              </span>
            )}
        </Label>

        <Popover
          open={open}
          onOpenChange={handleOpen}
          modal
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={cn(
                "w-full justify-between font-normal text-muted-foreground",
                atLimit &&
                  "opacity-50 cursor-not-allowed",
              )}
              disabled={atLimit}
            >
              {atLimit
                ? `Max ${APP_CONSTANTS.MAX_GREENHOUSE_COMPANIES} companies reached`
                : `Search companies (e.g., ${meta.searchExample})`}

              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronsUpDown className="h-4 w-4 opacity-50" />
              )}
            </Button>
          </PopoverTrigger>

          <PopoverContent
            className="p-0 w-(--radix-popover-trigger-width)"
            align="start"
            onOpenAutoFocus={(e) =>
              e.preventDefault()
            }
          >
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search or browse companies..."
                value={query}
                onValueChange={
                  handleQueryChange
                }
              />

              <CommandList
                onScroll={
                  handleListScroll
                }
              >
                {isSearching &&
                  results.length === 0 && (
                    <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Searching...
                    </div>
                  )}

                {!isSearching &&
                  results.length === 0 && (
                    <CommandEmpty>
                      No matches. Try
                      &quot;Add by URL&quot;
                      below.
                    </CommandEmpty>
                  )}

                {results.length > 0 && (
                  <CommandGroup>
                    {/* Select All */}
                    <CommandItem
                      value="__select_all_companies__"
                      onSelect={
                        selectAllResults
                      }
                      disabled={
                        atLimit &&
                        !allResultsSelected
                      }
                      className="font-medium"
                    >
                      <Check
                        className={cn(
                          "h-4 w-4 shrink-0",
                          allResultsSelected
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />

                      <span>
                        {allResultsSelected
                          ? "Deselect all"
                          : "Select all"}
                      </span>

                      <span className="ml-auto text-xs text-muted-foreground">
                        {results.length}{" "}
                        shown
                      </span>
                    </CommandItem>

                    {results.map((c) => {
                      const selected =
                        companies.some(
                          (sel) =>
                            sel.token ===
                            c.token,
                        );

                      return (
                        <CommandItem
                          key={c.token}
                          value={c.token}
                          disabled={
                            !selected &&
                            atLimit
                          }
                          onSelect={() =>
                            toggleCompany(
                              c,
                            )
                          }
                        >
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              selected
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />

                          <span>
                            {c.name}
                          </span>

                          <span className="ml-2 text-xs text-muted-foreground">
                            {c.token}
                          </span>

                          <a
                            href={companyBoardUrl(
                              provider,
                              c,
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${c.name} job board`}
                            title="Open job board"
                            onClick={(e) =>
                              e.stopPropagation()
                            }
                            onPointerDown={(
                              e,
                            ) =>
                              e.stopPropagation()
                            }
                            className="ml-auto text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {isSearching &&
                  results.length > 0 && (
                    <div className="flex items-center justify-center gap-2 p-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading more...
                    </div>
                  )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {companies.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {companies.map((c) => (
              <Badge
                key={c.token}
                variant="secondary"
                className="gap-1"
              >
                {c.name}

                <button
                  type="button"
                  onClick={() =>
                    removeCompany(
                      c.token,
                    )
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder={meta.urlHint}
            value={urlInput}
            disabled={atLimit}
            onChange={(e) =>
              setUrlInput(
                e.target.value,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                resolveUrl();
              }
            }}
          />

          <Button
            type="button"
            variant="outline"
            onClick={resolveUrl}
            disabled={
              isResolving ||
              atLimit ||
              urlInput.trim()
                .length === 0
            }
          >
            {isResolving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </Button>
        </div>

        {urlError && (
          <p className="text-sm text-destructive">
            {urlError}
          </p>
        )}

        <p className="text-sm text-muted-foreground">
          Select {meta.label} companies to
          monitor their job boards for new
          openings.
        </p>
      </div>

      {/* Target Job Titles */}
      <EntityStringChipInput
        label="Target job titles"
        placeholder="e.g., Frontend Engineer"
        noun="job title"
        description="Optional. Listings whose title matches rank higher."
        values={
          value.targetTitles ?? []
        }
        onChange={(next) =>
          onChange({
            ...value,
            targetTitles: next,
          })
        }
        loadOptions={async () => {
          const res =
            await getAllJobTitles();

          return Array.isArray(res)
            ? res
            : [];
        }}
        createOption={async (lbl) => {
          const res =
            await createJobTitle(
              lbl,
            );

          return res?.id
            ? res
            : null;
        }}
      />

      {/* Keywords */}
      <EntityStringChipInput
        label="Keywords / skills"
        placeholder="e.g., React"
        noun="keyword"
        description="Optional. Matched against title and description."
        values={
          value.keywords ?? []
        }
        onChange={(next) =>
          onChange({
            ...value,
            keywords: next,
          })
        }
        loadOptions={async () => {
          const res =
            await getAllTags();

          return Array.isArray(res)
            ? res
            : [];
        }}
        createOption={async (lbl) => {
          const res =
            await createTag(lbl);

          return res?.success
            ? res.data
            : null;
        }}
      />

      {noSignal && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />

          <span>
            Add at least one target title or
            keyword. Without them there is
            nothing to rank jobs against, so
            this automation will save no
            listings.
          </span>
        </div>
      )}

      {/* Locations */}
      <EntityStringChipInput
        label="Locations"
        placeholder="e.g., Canada, Remote"
        noun="location"
        description="Optional. Used only to filter results when the toggle below is on (not part of ranking)."
        values={
          value.locations ?? []
        }
        onChange={(next) =>
          onChange({
            ...value,
            locations: next,
          })
        }
        loadOptions={async () => {
          const res =
            await getAllJobLocations();

          return Array.isArray(res)
            ? res
            : [];
        }}
        createOption={async (lbl) => {
          const res =
            await createLocation(
              lbl,
            );

          return res?.success
            ? res.data
            : null;
        }}
      />

      {/* Strict Location */}
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-1">
          <Label>
            Only show jobs in these
            locations
          </Label>

          <p className="text-sm text-muted-foreground">
            When on, jobs matching none of
            your locations are dropped before
            ranking. Remote roles always pass.
          </p>
        </div>

        <Switch
          checked={
            !!value.strictLocation
          }
          disabled={
            (value.locations ?? [])
              .length === 0
          }
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              strictLocation:
                checked,
            })
          }
        />
      </div>

      {/* Jobs Analyzed Per Run */}
      <div className="space-y-2">
        <Label>
          Jobs analyzed per run:{" "}
          {value.topK ??
            APP_CONSTANTS.MAX_JOBS_PER_RUN}
        </Label>

        <Slider
          min={1}
          max={
            APP_CONSTANTS.GREENHOUSE_LISTING_CAP
          }
          step={1}
          value={[
            value.topK ??
              APP_CONSTANTS.MAX_JOBS_PER_RUN,
          ]}
          onValueChange={(next) =>
            onChange({
              ...value,
              topK: next[0],
            })
          }
        />

        <p className="text-sm text-muted-foreground">
          The number of listings that get
          full AI match analysis each run.
          Higher means more coverage but
          slower, costlier runs.
        </p>
      </div>

      {/* Save Additional Listings */}
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-1">
          <Label>
            Save additional relevant
            listings
          </Label>

          <p className="text-sm text-muted-foreground">
            When on, listings that are relevant
            but didn&apos;t make the top-K are
            also saved, lexically-ranked but
            not yet AI-scored. They can be
            analyzed on-demand later from the
            discovered jobs list.
          </p>
        </div>

        <Switch
          checked={
            value.saveUnanalyzed !==
            false
          }
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              saveUnanalyzed:
                checked,
            })
          }
        />
      </div>
    </div>
  );
}