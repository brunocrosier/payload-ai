'use client'

import type { SelectFieldProps } from '@payloadcms/ui'
import type { Option } from 'payload'

import { SelectField as Select, useField, useFieldProps } from '@payloadcms/ui'
import React, { useEffect, useState } from 'react'

export const SelectField = (props: SelectFieldProps) => {
  const fieldProps = useFieldProps()

  const { custom: selectOptions, path } = fieldProps
  const { options: optionsFromProps = [] } = props
  const { filterByField, options } = selectOptions

  const { value } = useField({
    path: filterByField,
  })
  const [filterOptions, setFilterOptions] = useState<Option[]>([])

  //TODO: Remove this mess, find alternative
  useEffect(() => {
    if (Array.isArray(options)) {
      const opts = options.filter((option) => {
        if (!value || !option.fields) return true

        if (Array.isArray(option.fields)) {
          return option.fields.includes(value)
        }
      })
      setFilterOptions(opts)
    } else {
      setFilterOptions(optionsFromProps)
    }
  }, [value, optionsFromProps, options])

  return <Select {...props} options={filterOptions} />
}
